#include "NodeMobileBridge.h"
#include <NodeMobile/NodeMobile.h>
#include <cstdlib>
#include <cstring>
#include <unistd.h>
#include <pthread.h>
#include <os/log.h>
#import <Foundation/Foundation.h>

/**
 * `nodejs-mobile` writes diagnostic output to stdout/stderr (file
 * descriptors 1 and 2). On Android the libnode build pipes those
 * fds into Android's `logcat`. On iOS no equivalent piping exists —
 * by default the writes go to fds inherited from the parent process,
 * which on a TestFlight / App Store build means /dev/null and on
 * Xcode debug means the Xcode console.
 *
 * Off by default for production consumers: keeping nodejs-mobile's
 * stdout going where iOS sends it normally avoids two production
 * concerns. (1) Routing every `console.log` through `os_log` with
 * `%{public}s` deliberately defeats the unified log's PII redaction;
 * any future identity-bearing log line would land in the device's
 * persistent log, retrievable via the standard sysdiagnose path.
 * (2) An always-on reader pthread is overhead production apps don't
 * pay otherwise.
 *
 * Opt-in via the Info.plist key `ComapeoStdoutToOsLog` (BOOL). The
 * bench app's `with-comapeo-bench` config plugin sets this true so
 * the BrowserStack runner can pull `BENCH_SPAN <json>` lines out of
 * the device console after each run. Production consumers leave the
 * key unset (or false) and inherit the legacy behavior.
 *
 * Strategy when enabled: dup2 stdout/stderr onto the write end of a
 * pipe before `node_start`, spawn a detached pthread that reads the
 * pipe line-by-line and forwards each line to `os_log` under the
 * `com.comapeo.nodejs` subsystem.
 *
 * Idempotency: pthread_once gates first-call setup so a second call
 * is a no-op.
 *
 * Performance: one extra pthread alive for the lifetime of the Node
 * process. read() on the pipe blocks; no busy-loop. Line-buffered
 * fgets bounds allocations by line length (BENCH_SPAN lines are
 * typically <500 bytes, well under the 64 KiB pipe buffer).
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
    NSNumber *redirectFlag = [[NSBundle mainBundle]
        objectForInfoDictionaryKey:@"ComapeoStdoutToOsLog"];
    if (redirectFlag != nil && [redirectFlag boolValue]) {
        pthread_once(&kNodeStdoutOnce, NodeMobileSetupLogPipe);
    }
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
