import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolve __dirname in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Directories
const RAW_MODELS_DIR = path.resolve(__dirname, '../assets/models/raw');
const OUTPUT_MODELS_DIR = path.resolve(__dirname, '../public/models');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_MODELS_DIR)) {
  fs.mkdirSync(OUTPUT_MODELS_DIR, { recursive: true });
}

/**
 * Compress a single GLB file using Draco compression
 */
async function compressModel(inputPath, outputPath) {
  const io = new NodeIO();

  // Register the Draco extension for reading and writing
  io.registerExtensions([KHRDracoMeshCompression]);

  // Read the input GLB file
  console.log(`📥 Reading: ${path.basename(inputPath)}`);
  const document = await io.read(inputPath);

  // Get original file size
  const originalSize = fs.statSync(inputPath).size;
  const originalSizeKB = (originalSize / 1024).toFixed(2);
  console.log(`   Original size: ${originalSizeKB} KB`);

  // Apply Draco mesh compression with quantization
  // Using aggressive settings for maximum compression suitable for AR/mobile
  await document.transform(
    draco({
      encoderOptions: {
        method: draco3d.EncoderMethod.EDGEBREAKER,
        encodeSpeed: 5,
        decodeSpeed: 5,
      },
      // Quantization settings for different attribute types
      quantizePosition: 14,  // 14-bit quantization for vertex positions
      quantizeNormal: 10,    // 10-bit quantization for normals
      quantizeColor: 8,      // 8-bit quantization for vertex colors
      quantizeTexcoord: 12,  // 12-bit quantization for UV coordinates
      quantizeGeneric: 12,   // 12-bit quantization for other attributes
      quantizeVolume: 8,     // 8-bit quantization for volume data
    })
  );

  // Write the compressed GLB file
  await io.write(outputPath, document);

  // Get compressed file size
  const compressedSize = fs.statSync(outputPath).size;
  const compressedSizeKB = (compressedSize / 1024).toFixed(2);
  const reductionPercent = ((1 - compressedSize / originalSize) * 100).toFixed(1);

  console.log(`📤 Written: ${path.basename(outputPath)}`);
  console.log(`   Compressed size: ${compressedSizeKB} KB (${reductionPercent}% reduction)`);
  console.log('');
}

/**
 * Main function to process all GLB files in the raw models directory
 */
async function main() {
  console.log('='.repeat(60));
  console.log('🔧 3D Model Draco Compression Pipeline');
  console.log('='.repeat(60));
  console.log('');
  console.log(`Input directory: ${RAW_MODELS_DIR}`);
  console.log(`Output directory: ${OUTPUT_MODELS_DIR}`);
  console.log('');

  // Find all .glb files in the raw models directory
  if (!fs.existsSync(RAW_MODELS_DIR)) {
    console.warn(`⚠️  Warning: Raw models directory not found: ${RAW_MODELS_DIR}`);
    console.log('   Skipping compression - no raw models to process.');
    process.exit(0);
  }

  const glbFiles = fs
    .readdirSync(RAW_MODELS_DIR)
    .filter((file) => file.toLowerCase().endsWith('.glb'));

  if (glbFiles.length === 0) {
    console.log('⚠️  No .glb files found in assets/models/raw/');
    console.log('   Place your raw GLB files there to compress them.');
    return;
  }

  console.log(`Found ${glbFiles.length} GLB file(s) to compress:`);
  glbFiles.forEach((file) => console.log(`   - ${file}`));
  console.log('');

  // Process each GLB file
  for (const glbFile of glbFiles) {
    const inputPath = path.join(RAW_MODELS_DIR, glbFile);
    const outputPath = path.join(OUTPUT_MODELS_DIR, glbFile);

    try {
      await compressModel(inputPath, outputPath);
    } catch (error) {
      console.error(`❌ Error compressing ${glbFile}:`, error.message);
    }
  }

  console.log('='.repeat(60));
  console.log('✅ Compression complete!');
  console.log('='.repeat(60));
}

// Run the compression pipeline
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
