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
  # Using the directory name (not a **/* glob) so that rsync preserves the
  # nodejs-project/ wrapper directory.  resolveJSEntryPoint expects files
  # inside Bundle.main/nodejs-project/.  Because the "Install Node.js
  # Project Dependencies" script phase runs before resource copying,
  # node_modules will be included automatically.
  s.resources = 'nodejs-project'

  # Install Node.js project npm dependencies before compilation
  s.script_phase = {
    :name => 'Install Node.js Project Dependencies',
    :script => 'if [ -f "${PODS_TARGET_SRCROOT}/nodejs-project/package.json" ]; then cd "${PODS_TARGET_SRCROOT}/nodejs-project" && npm install --omit=dev; fi',
    :execution_position => :before_compile
  }
end
