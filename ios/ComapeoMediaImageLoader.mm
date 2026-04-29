// React Native's RCTImageLoader looks up a registered RCTImageURLLoader
// by scheme BEFORE ever touching URLSession — so a globally-registered
// URLProtocol alone gives "No suitable image URL loader found for
// comapeo://...". This file plugs in to that lookup so RN's built-in
// <Image> can fetch our `comapeo://media/...` URLs.
//
// Implemented in Obj-C++ (.mm) so:
//   - RCT_EXPORT_MODULE() macro is available (RN's autolinking glue
//     needs an Obj-C class on the +load runtime hook).
//   - We can `#import "ComapeoCore-Swift.h"` to call into the shared
//     Swift `MediaFetcher` (same UDS-fetch logic that backs the
//     streaming URLProtocol).
//
// Streaming-vs-buffered: this loader buffers the full body into NSData
// because `[UIImage imageWithData:]` requires it. That matches RN's
// existing `RCTNetworkImageLoader` for http(s) — same peak memory
// shape. See MediaFetcher.swift for the streaming variant used by
// non-RN-Image consumers.

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <React/RCTImageURLLoader.h>

// `ComapeoCore-Swift.h` (auto-generated below) re-exposes every `@objc`
// Swift class in this module to Obj-C, including `AppLifecycleDelegate`
// which extends `BaseExpoAppDelegateSubscriber` from `ExpoModulesCore`.
// Without ExpoModulesCore in scope, the generated header references
// `EXBaseAppDelegateSubscriber` / `EXAppDelegateSubscriberProtocol`
// without a definition and the build fails. Module-import
// (`@import ExpoModulesCore;`) keeps the dependency self-documenting.
@import ExpoModulesCore;

// The auto-generated Swift bridging header lands in different paths
// depending on whether CocoaPods built ComapeoCore as a framework or a
// static library; cover both. `__has_include` is a Clang preprocessor
// check that resolves at compile time without erroring on the unmet
// branch.
#if __has_include(<ComapeoCore/ComapeoCore-Swift.h>)
#import <ComapeoCore/ComapeoCore-Swift.h>
#elif __has_include("ComapeoCore-Swift.h")
#import "ComapeoCore-Swift.h"
#endif

@interface ComapeoMediaImageLoader : NSObject <RCTImageURLLoader>
@end

@implementation ComapeoMediaImageLoader

RCT_EXPORT_MODULE()

- (BOOL)canLoadImageURL:(NSURL *)requestURL
{
    return [ComapeoMediaFetcher canHandle:requestURL];
}

- (float)loaderPriority
{
    // Higher than the default (0) so we win over any future loader that
    // also claims this scheme. Nothing else in RN's tree matches
    // `comapeo://` today, but being explicit is cheap.
    return 1.0;
}

- (BOOL)requiresScheduling
{
    // Defaults to YES, which routes us through RCTImageLoader's serial
    // url-cache queue. We have nothing to gain from that throttling —
    // the UDS pipe is already inside the app sandbox — and bypassing
    // the scheduler lets concurrent <Image>s fan out to MediaFetcher
    // independently.
    return NO;
}

- (RCTImageLoaderCancellationBlock)loadImageForURL:(NSURL *)imageURL
                                              size:(CGSize)size
                                             scale:(CGFloat)scale
                                        resizeMode:(RCTResizeMode)resizeMode
                                   progressHandler:(RCTImageLoaderProgressBlock)progressHandler
                                partialLoadHandler:(RCTImageLoaderPartialLoadBlock)partialLoadHandler
                                 completionHandler:(RCTImageLoaderCompletionBlock)completionHandler
{
    // The cancellation token wraps a heap-allocated flag so both the
    // returned cancel block and the fetcher completion can read/write
    // it without retaining each other.
    __block BOOL cancelled = NO;
    NSObject *cancelLock = [NSObject new];

    [ComapeoMediaFetcher fetchURL:imageURL
                       completion:^(NSData * _Nullable data, NSError * _Nullable error) {
        @synchronized (cancelLock) {
            if (cancelled) return;
        }

        if (error) {
            completionHandler(error, nil);
            return;
        }
        if (data == nil) {
            completionHandler(
                [NSError errorWithDomain:@"ComapeoMediaImageLoader"
                                    code:0
                                userInfo:@{NSLocalizedDescriptionKey:
                                               @"MediaFetcher returned no data and no error"}],
                nil);
            return;
        }

        UIImage *image = [UIImage imageWithData:data scale:scale];
        if (image == nil) {
            completionHandler(
                [NSError errorWithDomain:@"ComapeoMediaImageLoader"
                                    code:1
                                userInfo:@{NSLocalizedDescriptionKey:
                                               @"UIImage failed to decode response body"}],
                nil);
            return;
        }
        completionHandler(nil, image);
    }];

    return ^{
        @synchronized (cancelLock) {
            cancelled = YES;
        }
    };
}

@end
