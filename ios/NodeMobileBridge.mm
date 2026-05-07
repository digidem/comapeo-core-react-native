#include "NodeMobileBridge.h"
#include <NodeMobile/NodeMobile.h>
#include <cstdlib>
#include <cstring>
#include <unistd.h>
#include <pthread.h>
#include <os/log.h>
#import <Foundation/Foundation.h>

/**
 * Optional iOS pipe + dup2 → os_log redirect for nodejs-mobile stdout.
 * Off by default; opt-in via Info.plist `ComapeoStdoutToOsLog` BOOL.
 *
 * Production stays off because routing every `console.log` through
 * `os_log` with `%{public}s` defeats the unified log's PII redaction
 * — any identity-bearing log line would land in the device's
 * persistent log, retrievable via sysdiagnose. The bench app opts
 * in so BrowserStack can pull `BENCH_SPAN` lines out of device logs.
 *
 * Android gets this for free: libnode pipes stdout/stderr into logcat.
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
        // `%{public}s` — without `public`, os_log redacts in release.
        os_log(kNodeStdoutLog, "%{public}s", buf);
    }
    fclose(stream);
    return NULL;
}

static void NodeMobileSetupLogPipe(void) {
    kNodeStdoutLog = os_log_create("com.comapeo.nodejs", "stdout");
    int fds[2];
    if (pipe(fds) != 0) return;
    // Both fds onto the pipe so `console.log` + `console.error` surface.
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
        // Best-effort: thread create failed; close read fd to avoid leak.
        close(fds[0]);
    }
}

int32_t NodeMobileStartNode(int argc, const char *argv[]) {
    NSNumber *redirectFlag = [[NSBundle mainBundle]
        objectForInfoDictionaryKey:@"ComapeoStdoutToOsLog"];
    if (redirectFlag != nil && [redirectFlag boolValue]) {
        pthread_once(&kNodeStdoutOnce, NodeMobileSetupLogPipe);
    }
    // libUV requires argv strings in one contiguous allocation.
    size_t total_size = 0;
    for (int i = 0; i < argc; i++) {
        total_size += strlen(argv[i]) + 1;
    }

    char *args_buffer = (char *)calloc(total_size, sizeof(char));
    if (!args_buffer) {
        return -1;
    }
    char **contiguous_argv = (char **)malloc(argc * sizeof(char *));
    if (!contiguous_argv) {
        free(args_buffer);
        return -1;
    }
    char *current_pos = args_buffer;
    for (int i = 0; i < argc; i++) {
        size_t len = strlen(argv[i]);
        memcpy(current_pos, argv[i], len);
        current_pos[len] = '\0';
        contiguous_argv[i] = current_pos;
        current_pos += len + 1;
    }

    // Blocks until the runtime exits.
    int exit_code = node_start(argc, contiguous_argv);

    free(contiguous_argv);
    free(args_buffer);

    return (int32_t)exit_code;
}
