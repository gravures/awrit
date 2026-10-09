// Single resolution point for the in-tree native addon.
// awrit-native-rs is a source-tree component, not an npm package: it is
// deliberately absent from node_modules, so it is imported by path.
// 09-02 extends this file with the release-tarball layout; keep layout
// knowledge here and nowhere else.
export * from '../awrit-native-rs';
