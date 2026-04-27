require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ComapeoCore'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = package['author']
  s.homepage       = package['homepage']
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  s.swift_version  = '5.4'
  s.source         = { git: 'https://github.com/digidem/comapeo-core-react-native' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # NodeMobile.xcframework provides the embedded Node.js runtime
  s.vendored_frameworks = 'NodeMobile.xcframework'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'ENABLE_BITCODE' => 'NO',
  }

  s.source_files = "*.{h,m,mm,swift,hpp,cpp}"
  s.exclude_files = "Tests/**", "Package.swift"

  # Bundle the Node.js project directory into the app bundle.
  # IMPORTANT: node_modules must exist before `pod install` runs, otherwise
  # CocoaPods enumerates individual files and copies them flat (losing the
  # directory structure). When node_modules exists, CocoaPods treats
  # nodejs-project as a single directory resource and preserves the structure.
  # Run `cd ios/nodejs-project && npm install --omit=dev` before `pod install`.
  s.resources = 'nodejs-project'

  # Install Node.js project npm dependencies before compilation.
  # This also ensures node_modules exists for subsequent `pod install` runs.
  # Skipped when node_modules already exists so incremental builds don't pay
  # npm's startup cost on every compile.
  s.script_phase = {
    :name => 'Install Node.js Project Dependencies',
    :script => <<~SCRIPT,
      NODEJS_PROJECT_DIR="${PODS_TARGET_SRCROOT}/nodejs-project"
      if [ ! -f "${NODEJS_PROJECT_DIR}/package.json" ]; then
        exit 0
      fi
      if [ -d "${NODEJS_PROJECT_DIR}/node_modules" ]; then
        echo "node_modules already present — skipping npm install"
        exit 0
      fi
      # Resolve NODE_BINARY using the same .xcode.env mechanism as React Native / Expo.
      if [ -f "${PODS_ROOT}/../.xcode.env" ]; then source "${PODS_ROOT}/../.xcode.env"; fi
      if [ -f "${PODS_ROOT}/../.xcode.env.local" ]; then source "${PODS_ROOT}/../.xcode.env.local"; fi
      if [ -z "$NODE_BINARY" ]; then NODE_BINARY="$(command -v node)"; fi
      # Add node's bin dir to PATH so npm's #!/usr/bin/env node shebang resolves correctly.
      export PATH="$(dirname "$NODE_BINARY"):$PATH"
      NPM_BINARY="$(dirname "$NODE_BINARY")/npm"
      cd "${NODEJS_PROJECT_DIR}" && "$NPM_BINARY" install --omit=dev
    SCRIPT
    :execution_position => :before_compile
  }
end
