#include "NodeMobileBridge.h"
#include <NodeMobile/NodeMobile.h>
#include <cstdlib>
#include <cstring>

int32_t NodeMobileStartNode(int argc, const char *argv[]) {
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
