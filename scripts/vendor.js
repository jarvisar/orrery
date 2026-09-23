#!/usr/bin/env node
/**
 * Copies the exact three.js files the app imports out of node_modules and into
 * vendor/, so the deployed site has no third-party CDN on its critical path.
 *
 * Re-run after bumping three in package.json:  npm run vendor
 */
import { mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'three');
const dest = join(root, 'vendor', 'three');

// three.module.js re-exports three.core.js, so both are required.
const FILES = [
  ['build/three.module.js', 'three.module.js'],
  ['build/three.core.js', 'three.core.js'],
  ['examples/jsm/controls/OrbitControls.js', 'addons/controls/OrbitControls.js'],
  ['examples/jsm/loaders/GLTFLoader.js', 'addons/loaders/GLTFLoader.js'],
  ['examples/jsm/utils/BufferGeometryUtils.js', 'addons/utils/BufferGeometryUtils.js'],
  ['examples/jsm/utils/SkeletonUtils.js', 'addons/utils/SkeletonUtils.js'],
  ['examples/jsm/lines/Line2.js', 'addons/lines/Line2.js'],
  ['examples/jsm/lines/LineGeometry.js', 'addons/lines/LineGeometry.js'],
  ['examples/jsm/lines/LineMaterial.js', 'addons/lines/LineMaterial.js'],
  ['examples/jsm/lines/LineSegments2.js', 'addons/lines/LineSegments2.js'],
  ['examples/jsm/lines/LineSegmentsGeometry.js', 'addons/lines/LineSegmentsGeometry.js'],
  // Post-processing: bloom, and the composer it runs in.
  ['examples/jsm/postprocessing/EffectComposer.js', 'addons/postprocessing/EffectComposer.js'],
  ['examples/jsm/postprocessing/Pass.js', 'addons/postprocessing/Pass.js'],
  ['examples/jsm/postprocessing/RenderPass.js', 'addons/postprocessing/RenderPass.js'],
  ['examples/jsm/postprocessing/ShaderPass.js', 'addons/postprocessing/ShaderPass.js'],
  ['examples/jsm/postprocessing/MaskPass.js', 'addons/postprocessing/MaskPass.js'],
  ['examples/jsm/postprocessing/UnrealBloomPass.js', 'addons/postprocessing/UnrealBloomPass.js'],
  ['examples/jsm/shaders/CopyShader.js', 'addons/shaders/CopyShader.js'],
  ['examples/jsm/shaders/LuminosityHighPassShader.js', 'addons/shaders/LuminosityHighPassShader.js'],
  // VR: controller and hand models. Only loaded once a headset session starts.
  ['examples/jsm/webxr/XRControllerModelFactory.js', 'addons/webxr/XRControllerModelFactory.js'],
  ['examples/jsm/webxr/XRHandModelFactory.js', 'addons/webxr/XRHandModelFactory.js'],
  ['examples/jsm/webxr/XRHandMeshModel.js', 'addons/webxr/XRHandMeshModel.js'],
  ['examples/jsm/webxr/XRHandPrimitiveModel.js', 'addons/webxr/XRHandPrimitiveModel.js'],
  ['examples/jsm/libs/motion-controllers.module.js', 'addons/libs/motion-controllers.module.js'],
  ['LICENSE', 'LICENSE'],
];

await rm(dest, { recursive: true, force: true });
for (const [from, to] of FILES) {
  const target = join(dest, to);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(src, from), target);
}

const { version } = JSON.parse(await readFile(join(src, 'package.json'), 'utf8'));
await writeFile(
  join(dest, 'VERSION'),
  `three@${version}\nVendored by scripts/vendor.js on ${new Date().toISOString().slice(0, 10)}.\n` +
    `Do not edit these files by hand - bump three in package.json and re-run "npm run vendor".\n`
);

console.log(`vendored three@${version} -> vendor/three (${FILES.length} files)`);
