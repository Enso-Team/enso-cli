// Counts F_FULLFSYNC and fsync calls made by the process (macOS DYLD interposing).
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
static int fullfsyncs = 0, fsyncs = 0;
static int my_fcntl(int fd, int cmd, ...) {
  va_list ap; va_start(ap, cmd); void *arg = va_arg(ap, void *); va_end(ap);
  if (cmd == F_FULLFSYNC) fullfsyncs++;
  return fcntl(fd, cmd, arg);
}
static int my_fsync(int fd) { fsyncs++; return fsync(fd); }
__attribute__((destructor)) static void report(void) { fprintf(stderr, "F_FULLFSYNC=%d fsync=%d\n", fullfsyncs, fsyncs); }
__attribute__((used)) static struct { const void *replacement; const void *original; } interposers[] __attribute__((section("__DATA,__interpose"))) = {
  { (const void *)my_fcntl, (const void *)fcntl }, { (const void *)my_fsync, (const void *)fsync },
};
