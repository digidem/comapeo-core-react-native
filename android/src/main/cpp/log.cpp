#include <android/log.h>

const char *ADBTAG = "Comapeo:NodeJS";

void log(const char *message, ...) {
    va_list args;
    va_start(args, message);
    __android_log_vprint(ANDROID_LOG_INFO, ADBTAG, message, args);
    va_end(args);
}
