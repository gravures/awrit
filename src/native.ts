// Single resolution point for the in-tree native addon.
// awrit-native-rs is a source-tree component, not an npm package: it is
// deliberately absent from node_modules, so it is imported by path.
//
// 09-02 Task 2: this stays the one import specifier for both layouts. Bundles
// externalize `*/awrit-native-rs`, so the require is resolved at runtime relative
// to the bundle: the dev checkout resolves `../awrit-native-rs/`, and the release
// tarball ships the napi loader + `.node` at `<install-root>/awrit-native-rs/`.
export * from '../awrit-native-rs';
