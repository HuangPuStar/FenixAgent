/* Fixed ABI wrapper; the variadic Darwin arm64 mode argument belongs on the stack. */
typedef int (*openat_function)(int, const char *, int, ...);
int fenix_openat(void *function, int directory, const char *path, int flags, int mode) {
  return ((openat_function)function)(directory, path, flags, mode);
}
