require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# Debug-only companion pod: ships the embedded backend bundle's sourcemaps.
#
# The config plugin (app.plugin.js) adds this to the consumer's Podfile with
# `:configurations => ['Debug']`, so CocoaPods copies these resources only in
# Debug builds — Release IPAs never carry the (multi-MB) maps. Native passes
# Node's `--enable-source-maps` under `#if DEBUG`, so backend errors are
# remapped to original positions in-process and reach Sentry symbolicated with
# no upload. Release builds instead rely on the consumer uploading the same
# maps via `comapeo-rn-upload-sourcemaps` (debug-ID matched, server-side).
#
# Not autolinked: `expo-module.config.json` pins `apple.podspecPath` to the
# main `ComapeoCore.podspec`, so Expo only links that one and this pod is only
# ever added via the explicit, config-scoped Podfile entry above.
Pod::Spec.new do |s|
  s.name           = 'ComapeoCoreSourcemaps'
  s.version        = package['version']
  s.summary        = 'Debug-only backend sourcemaps for in-process symbolication'
  s.description    = 'Ships @comapeo/core-react-native backend sourcemaps as a Debug-only resource.'
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: 'https://github.com/digidem/comapeo-core-react-native' }

  # Maps are laid out as a `nodejs-project/` dir (mirroring the bundle: the
  # `relocateSourcemapsPlugin` writes `index.mjs.map`, `loader.mjs.map`,
  # `chunks/*.map`). CocoaPods copies `nodejs-project` into the app bundle
  # root, where it MERGES with the main pod's `nodejs-project` (the resource
  # rsync runs without `--delete`, so the bundle files survive). Each map then
  # sits next to its bundle file, so Node resolves the relative
  # `//# sourceMappingURL=index.mjs.map` at runtime.
  s.resources      = ['nodejs-sourcemaps/nodejs-project']
end
