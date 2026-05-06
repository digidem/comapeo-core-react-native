#include "NodeMobileBridge.h"
#include <NodeMobile/NodeMobile.h>
#include <cstdlib>
#include <cstring>
#include <unistd.h>
#include <pthread.h>
#include <os/log.h>

/**
 * `nodejs-mobile` writes diagnostic output to stdout/stderr (file
 * descriptors 1 and 2). On Android the libnode build pipes those
 * fds into Android's `logcat` so `console.log` from the rolled-up
 * backend lands under the `Comapeo:NodeJS` tag automatically. On
 * iOS, no equivalent piping exists — by default the writes go to
 * fds inherited from the parent process, which on a TestFlight /
 * App Store build means /dev/null and on Xcode debug means the
 * Xcode console. Neither route is captured by the iOS unified
 * log subsystem (`os_log`), which is what BrowserStack pulls via
 * the device-log endpoint.
 *
 * The bench app's logcat-based span transport relies on every
 * `console.log("BENCH_SPAN ...")` line surfacing in the device
 * log, so without an iOS redirect, server-side spans (boot phases
 * and any future bench backend output) are invisible to the
 * BrowserStack runner.
 *
 * Strategy: dup2 stdout/stderr onto the write end of a pipe before
 * `node_start`, then spawn a detached pthread that reads the read
 * end line-by-line and forwards each line to `os_log` under a
 * dedicated subsystem. The subsystem is namespaced
 * (`com.comapeo.nodejs`) so a downstream filter can pull only
 * Node-originated lines.
 *
 * Idempotency: only redirects on the first call. A second call
 * (e.g. if a future codepath ever re-invoked the bridge) is a
 * no-op since the dup2 result has already replaced fd 1/2.
 *
 * Performance: one extra pthread alive for the lifetime of the
 * Node process. read() on the pipe blocks; we don't busy-loop. A
 * line-buffered fgets keeps allocations bounded by line length
 * (BENCH_SPAN lines are typically <500 bytes, well under the
 * 64 KiB pipe buffer).
 */
static os_log_t kNodeStdoutLog;
static pthread_once_t kNodeStdoutOnce = PTHREAD_ONCE_INIT;

static void *NodeMobileLogPipeReader(void *arg) {
    int readFd = (int)(intptr_t)arg;
    FILE *stream = fdopen(readFd, "r");
    if (!stream) {
        close(readFd);
        return NULL;
    }
    char buf[4096];
    while (fgets(buf, sizeof(buf), stream)) {
        size_t len = strlen(buf);
        if (len > 0 && buf[len - 1] == '\n') buf[len - 1] = '\0';
        // %{public}s — without `public`, os_log redacts the string in
        // production builds. We need it readable in BS device logs.
        os_log(kNodeStdoutLog, "%{public}s", buf);
    }
    fclose(stream);
    return NULL;
}

static void NodeMobileSetupLogPipe(void) {
    kNodeStdoutLog = os_log_create("com.comapeo.nodejs", "stdout");
    int fds[2];
    if (pipe(fds) != 0) return;
    // Replace stdout AND stderr with the write end of the pipe so
    // `console.log` and `console.error` both surface.
    dup2(fds[1], STDOUT_FILENO);
    dup2(fds[1], STDERR_FILENO);
    close(fds[1]);
    setvbuf(stdout, NULL, _IOLBF, 0);
    setvbuf(stderr, NULL, _IOLBF, 0);
    pthread_t reader;
    if (pthread_create(&reader, NULL, NodeMobileLogPipeReader,
                       (void *)(intptr_t)fds[0]) == 0) {
        pthread_detach(reader);
    } else {
        // Pipe creation succeeded but thread didn't — close the read
        // end so we don't leak the descriptor; output will go to
        // the redirected fd but no reader will drain it (eventually
        // blocks on a full pipe buffer). Best-effort.
        close(fds[0]);
    }
}

int32_t NodeMobileStartNode(int argc, const char *argv[]) {
    pthread_once(&kNodeStdoutOnce, NodeMobileSetupLogPipe);
    // libUV requires all arguments to reside in contiguous memory.
    // Compute total size needed for all argument strings.
    size_t total_size = 0;
    for (int i = 0; i < argc; i++) {
        total_size += strlen(argv[i]) + 1; // +1 for null terminator
    }

    // Allocate a single contiguous buffer for all argument strings.
    char *args_buffer = (char *)calloc(total_size, sizeof(char));
    if (!args_buffer) {
        return -1;
    }

    // Allocate argv pointer array.
    char **contiguous_argv = (char **)malloc(argc * sizeof(char *));
    if (!contiguous_argv) {
        free(args_buffer);
        return -1;
    }

    // Copy each argument into the contiguous buffer.
    char *current_pos = args_buffer;
    for (int i = 0; i < argc; i++) {
        size_t len = strlen(argv[i]);
        memcpy(current_pos, argv[i], len);
        current_pos[len] = '\0';
        contiguous_argv[i] = current_pos;
        current_pos += len + 1;
    }

    // Start Node.js — this blocks until the runtime exits.
    int exit_code = node_start(argc, contiguous_argv);

    free(contiguous_argv);
    free(args_buffer);

    return (int32_t)exit_code;
}
