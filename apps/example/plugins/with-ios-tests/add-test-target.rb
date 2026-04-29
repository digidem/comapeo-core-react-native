#!/usr/bin/env ruby
# Adds an XCTest target to the generated Xcode project, linked against
# the main app as host. Driven by the with-ios-tests Expo config plugin
# during `expo prebuild`.
require 'xcodeproj'

app_name       = ENV.fetch('APP_TARGET_NAME')
test_name      = ENV.fetch('TEST_TARGET_NAME')
test_bundle_id = ENV.fetch('TEST_BUNDLE_ID')
deployment     = ENV.fetch('IPHONEOS_DEPLOYMENT_TARGET', '15.1')

project_path = "#{app_name}.xcodeproj"
project      = Xcodeproj::Project.open(project_path)

app_target = project.targets.find { |t| t.name == app_name } \
  or abort("with-ios-tests: app target '#{app_name}' not found")

test_target = project.targets.find { |t| t.name == test_name }

if test_target.nil?
  test_target = project.new_target(:unit_test_bundle, test_name, :ios, deployment)

  test_target.build_configurations.each do |config|
    bs = config.build_settings
    bs['PRODUCT_NAME']                = '$(TARGET_NAME)'
    bs['IPHONEOS_DEPLOYMENT_TARGET']  = deployment
    bs['GENERATE_INFOPLIST_FILE']     = 'YES'
    bs['TEST_HOST']                   = "$(BUILT_PRODUCTS_DIR)/#{app_name}.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/#{app_name}"
    bs['BUNDLE_LOADER']               = '$(TEST_HOST)'
    bs['PRODUCT_BUNDLE_IDENTIFIER']   = test_bundle_id
    bs['ENABLE_USER_SCRIPT_SANDBOXING'] = 'NO'
    # Swift 5.9 minimum: the auto-generated Pods-corereactnativeexampleTests
    # ExpoModulesProvider.swift uses Swift 5.9+'s `internal import X`
    # access-level-on-import syntax (SE-0409). Compiling the test target
    # in Swift 5.0 mode triggers "ambiguous implicit access level" errors
    # against our `@testable import ComapeoCore` because the two imports
    # disagree on whether the access level is explicit or implicit.
    bs['SWIFT_VERSION']               = '5.9'
    bs['CLANG_ENABLE_MODULES']        = 'YES'
  end

  test_target.add_dependency(app_target)
end

# Register on-disk source files (idempotent). Runs every time — not just
# on first target creation — so newly added .swift files in
# example/tests/ios/ get wired up on subsequent prebuilds without
# requiring a full --clean rebuild. Skips files already present in the
# group AND already in the build phase.
group = project.main_group.find_subpath(test_name, true)
group.set_source_tree('<group>') if group.source_tree != '<group>'
group.set_path(test_name) if group.path != test_name

existing_paths = group.files.map(&:path)
sources_phase = test_target.source_build_phase
existing_phase_paths = sources_phase.files.map { |bf| bf.file_ref&.path }.compact

Dir[File.join(test_name, '*.swift')].sort.each do |src|
  basename = File.basename(src)
  file_ref = if existing_paths.include?(basename)
               group.files.find { |f| f.path == basename }
             else
               group.new_reference(basename)
             end
  unless existing_phase_paths.include?(basename)
    test_target.add_file_references([file_ref])
  end
end

project.save
