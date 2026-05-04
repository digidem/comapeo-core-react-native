# Patches

## `@mapeo/mock-data`

### [Vendor CoMapeo Geometry JSON schema](./@mapeo+mock-data+5.0.0+001+vendor-geometry-json-schema.patch)

Metro + Hermes cannot resolve `module` since it's specific to Node. Instead we just copy the contents of the file that it's trying to read and parse and insert that into the source.

### [Fix import for `dereference-json-schema`](./@mapeo+mock-data+5.0.0+002+fix-import-from-dereference-json-schema.patch)

Was encountering a runtime error about not being able to call `dereferenceSync` on `undefined`. Fixes the import to align with ESM syntax i.e. `import * as _ from '...'`
