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

unless project.targets.any? { |t| t.name == test_name }
  test_target = project.new_target(:unit_test_bundle, test_name, :ios, deployment)

  # Register the on-disk source files. Expo's prebuild + this plugin's
  # mod hook has already copied them into ios/<test_name>/.
  group = project.main_group.new_group(test_name, test_name)
  Dir[File.join(test_name, '*.swift')].sort.each do |src|
    file_ref = group.new_reference(File.basename(src))
    test_target.add_file_references([file_ref])
  end

  test_target.build_configurations.each do |config|
    bs = config.build_settings
    bs['PRODUCT_NAME']                = '$(TARGET_NAME)'
    bs['IPHONEOS_DEPLOYMENT_TARGET']  = deployment
    bs['GENERATE_INFOPLIST_FILE']     = 'YES'
    bs['TEST_HOST']                   = "$(BUILT_PRODUCTS_DIR)/#{app_name}.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/#{app_name}"
    bs['BUNDLE_LOADER']               = '$(TEST_HOST)'
    bs['PRODUCT_BUNDLE_IDENTIFIER']   = test_bundle_id
    bs['ENABLE_USER_SCRIPT_SANDBOXING'] = 'NO'
    bs['SWIFT_VERSION']               = '5.0'
    bs['CLANG_ENABLE_MODULES']        = 'YES'
  end

  test_target.add_dependency(app_target)
end

project.save
