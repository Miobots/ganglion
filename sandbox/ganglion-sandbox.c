/*
 * ganglion-sandbox — the kernel half of the daemon's confinement (G5.2, G5.3; GANGLION_DECISIONS 36).
 *
 *   ganglion-sandbox [--ro PATH]... [--rw PATH]... [--connect-port PORT]... -- PROGRAM [ARGS...]
 *
 * Before exec'ing PROGRAM it:
 *   1. sets no_new_privs, so nothing it runs can gain privileges (setuid binaries stay plain);
 *   2. applies Landlock: files are read/executed only under --ro paths and written only under --rw
 *      paths; TCP connect is allowed only to --connect-port ports and TCP bind to none, so the
 *      daemon can reach the Brain and nothing else, and can never listen; it cannot signal or
 *      reach abstract Unix sockets outside its own sandbox;
 *   3. installs a seccomp filter that refuses system calls a desktop daemon has no use for
 *      (debugging other processes, mounting, kernel modules, BPF, keyrings, namespaces...).
 * Every rule is inherited by everything PROGRAM starts. Fails closed: if Landlock is missing, it
 * refuses to run rather than run unconfined.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#define FILE_RIGHTS (LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_READ_FILE | \
                     LANDLOCK_ACCESS_FS_TRUNCATE | LANDLOCK_ACCESS_FS_IOCTL_DEV)
#define READ_RIGHTS (LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR)

static void die(const char *what) {
  fprintf(stderr, "[sandbox] %s: %s\n", what, strerror(errno));
  exit(126);
}

static __u64 fs_rights(int abi) {
  __u64 all = (LANDLOCK_ACCESS_FS_MAKE_SYM << 1) - 1; /* ABI 1 */
  if (abi >= 2) all |= LANDLOCK_ACCESS_FS_REFER;
  if (abi >= 3) all |= LANDLOCK_ACCESS_FS_TRUNCATE;
  if (abi >= 5) all |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
  return all;
}

static void allow_path(int ruleset, const char *path, __u64 access, __u64 handled) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) {
    fprintf(stderr, "[sandbox] skipping %s: %s\n", path, strerror(errno));
    return;
  }
  struct stat st;
  if (fstat(fd, &st) < 0) die("fstat");
  struct landlock_path_beneath_attr rule = {
    .allowed_access = access & handled & (S_ISDIR(st.st_mode) ? ~0ULL : FILE_RIGHTS),
    .parent_fd = fd,
  };
  if (syscall(__NR_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0)) die(path);
  close(fd);
}

/* System calls refused with EPERM. Anything not listed is allowed: a list of what Bun, ffmpeg and
 * a shell script need would be long and brittle, so this closes the dangerous doors instead. */
static const int denied[] = {
  SYS_ptrace, SYS_process_vm_readv, SYS_process_vm_writev,
  SYS_mount, SYS_umount2, SYS_pivot_root, SYS_chroot,
#ifdef SYS_mount_setattr
  SYS_mount_setattr, SYS_move_mount, SYS_open_tree, SYS_fsopen, SYS_fsmount, SYS_fsconfig, SYS_fspick,
#endif
  SYS_swapon, SYS_swapoff, SYS_reboot, SYS_kexec_load,
#ifdef SYS_kexec_file_load
  SYS_kexec_file_load,
#endif
  SYS_init_module, SYS_finit_module, SYS_delete_module,
  SYS_bpf, SYS_perf_event_open, SYS_userfaultfd,
  SYS_keyctl, SYS_add_key, SYS_request_key,
  SYS_setns, SYS_unshare,
  SYS_open_by_handle_at, SYS_name_to_handle_at,
  SYS_acct, SYS_settimeofday, SYS_clock_settime, SYS_clock_adjtime, SYS_adjtimex,
  SYS_quotactl, SYS_fanotify_init,
#ifdef SYS_iopl
  SYS_iopl, SYS_ioperm,
#endif
};

static void install_seccomp(void) {
#if defined(__x86_64__)
  const __u32 arch = AUDIT_ARCH_X86_64;
#elif defined(__aarch64__)
  const __u32 arch = AUDIT_ARCH_AARCH64;
#else
#error "ganglion-sandbox supports x86_64 and aarch64"
#endif
  const size_t n = sizeof(denied) / sizeof(denied[0]);
  struct sock_filter filter[8 + 2 * (sizeof(denied) / sizeof(denied[0]))];
  size_t i = 0;
  filter[i++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch));
  filter[i++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, arch, 1, 0);
  filter[i++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
  filter[i++] = (struct sock_filter)BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
#if defined(__x86_64__)
  /* The x32 ABI would be a second door to every call below. */
  filter[i++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1);
  filter[i++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS);
#endif
  for (size_t k = 0; k < n; k++) {
    filter[i++] = (struct sock_filter)BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (__u32)denied[k], 0, 1);
    filter[i++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
  }
  filter[i++] = (struct sock_filter)BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  struct sock_fprog prog = { .len = (unsigned short)i, .filter = filter };
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog)) die("seccomp");
  fprintf(stderr, "[sandbox] seccomp: %zu system calls refused\n", n);
}

int main(int argc, char **argv) {
  const char *ro[256], *rw[256];
  long ports[16];
  int nro = 0, nrw = 0, nports = 0, i = 1;
  for (; i < argc; i++) {
    if (!strcmp(argv[i], "--")) { i++; break; }
    if (i + 1 >= argc) break;
    if (!strcmp(argv[i], "--ro") && nro < 256) ro[nro++] = argv[++i];
    else if (!strcmp(argv[i], "--rw") && nrw < 256) rw[nrw++] = argv[++i];
    else if (!strcmp(argv[i], "--connect-port") && nports < 16) ports[nports++] = strtol(argv[++i], NULL, 10);
    else { fprintf(stderr, "[sandbox] unknown option %s\n", argv[i]); return 2; }
  }
  if (i >= argc) {
    fprintf(stderr, "usage: ganglion-sandbox [--ro PATH]... [--rw PATH]... [--connect-port PORT]... -- PROGRAM [ARGS...]\n");
    return 2;
  }

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) die("no_new_privs");

  int abi = (int)syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 4) {
    fprintf(stderr, "[sandbox] refusing to run: this kernel's Landlock (ABI %d) cannot restrict TCP; need ABI 4 or newer\n", abi);
    return 126;
  }
  const __u64 handled = fs_rights(abi);
  struct landlock_ruleset_attr attr = {
    .handled_access_fs = handled,
    .handled_access_net = LANDLOCK_ACCESS_NET_BIND_TCP | LANDLOCK_ACCESS_NET_CONNECT_TCP,
#ifdef LANDLOCK_SCOPE_SIGNAL
    .scoped = abi >= 6 ? (LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET | LANDLOCK_SCOPE_SIGNAL) : 0,
#endif
  };
  int ruleset = (int)syscall(__NR_landlock_create_ruleset, &attr, sizeof(attr), 0);
  if (ruleset < 0) die("landlock_create_ruleset");
  for (int k = 0; k < nro; k++) allow_path(ruleset, ro[k], READ_RIGHTS, handled);
  for (int k = 0; k < nrw; k++) allow_path(ruleset, rw[k], handled, handled);
  for (int k = 0; k < nports; k++) {
    struct landlock_net_port_attr port = { .allowed_access = LANDLOCK_ACCESS_NET_CONNECT_TCP, .port = (__u64)ports[k] };
    if (syscall(__NR_landlock_add_rule, ruleset, LANDLOCK_RULE_NET_PORT, &port, 0)) die("landlock port rule");
  }
  if (syscall(__NR_landlock_restrict_self, ruleset, 0)) die("landlock_restrict_self");
  close(ruleset);
  fprintf(stderr, "[sandbox] landlock ABI %d: %d read-only and %d writable paths; TCP connect to %d port(s) only; no TCP listen\n", abi, nro, nrw, nports);

  install_seccomp();
  execvp(argv[i], &argv[i]);
  die(argv[i]);
}
