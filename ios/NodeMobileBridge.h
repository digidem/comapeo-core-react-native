#ifndef NodeMobileBridge_h
#define NodeMobileBridge_h

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/// Start the Node.js runtime with the given arguments.
/// Arguments are copied into contiguous memory as required by libUV.
/// This function blocks until Node.js exits.
/// Returns the Node.js exit code.
int32_t NodeMobileStartNode(int argc, const char *argv[]);

#ifdef __cplusplus
}
#endif

#endif /* NodeMobileBridge_h */
