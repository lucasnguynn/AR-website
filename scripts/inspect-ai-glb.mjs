import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const TRIANGLES = 4;
const TRIANGLE_STRIP = 5;
const TRIANGLE_FAN = 6;

const inputPath = resolve(process.argv[2] ?? 'assets/models/incoming/nhan-test.glb');
const outputDir = resolve(process.argv[3] ?? 'reports/ai-model-intake');

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
}

function parseGlb(buffer) {
  if (buffer.length < 20) throw new Error('File is too small to be a valid GLB 2.0 asset.');

  const magic = buffer.readUInt32LE(0);
  const version = buffer.readUInt32LE(4);
  const declaredLength = buffer.readUInt32LE(8);

  if (magic !== GLB_MAGIC) throw new Error('Invalid GLB magic header. Expected binary glTF (glTF).');
  if (version !== 2) throw new Error(`Unsupported GLB version ${version}. Expected glTF 2.0.`);
  if (declaredLength !== buffer.length) {
    throw new Error(`GLB length mismatch: header=${declaredLength}, actual=${buffer.length}.`);
  }

  let offset = 12;
  let json;

  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;

    if (chunkEnd > buffer.length) throw new Error('GLB chunk extends beyond the file boundary.');

    if (chunkType === JSON_CHUNK) {
      const text = buffer
        .subarray(chunkStart, chunkEnd)
        .toString('utf8')
        .replace(/[\u0000\u0020]+$/g, '');
      json = JSON.parse(text);
    }

    offset = chunkEnd;
  }

  if (!json) throw new Error('GLB does not contain a JSON chunk.');
  return json;
}

function accessorCount(gltf, accessorIndex) {
  const accessor = gltf.accessors?.[accessorIndex];
  return Number.isFinite(accessor?.count) ? accessor.count : 0;
}

function primitiveTriangleCount(gltf, primitive) {
  const mode = primitive.mode ?? TRIANGLES;
  const count = primitive.indices !== undefined
    ? accessorCount(gltf, primitive.indices)
    : accessorCount(gltf, primitive.attributes?.POSITION);

  if (mode === TRIANGLES) return Math.floor(count / 3);
  if (mode === TRIANGLE_STRIP || mode === TRIANGLE_FAN) return Math.max(0, count - 2);
  return 0;
}

function roleFromExtras(extras) {
  const role = normalizeText(extras?.materialRole);
  return role === 'metal' || role === 'gemstone' ? role : undefined;
}

function collectNodeRoles(gltf) {
  const byMesh = new Map();
  for (const node of gltf.nodes ?? []) {
    if (!Number.isInteger(node.mesh)) continue;
    const role = roleFromExtras(node.extras);
    const gemstoneType = normalizeText(node.extras?.gemstoneType);
    const entry = byMesh.get(node.mesh) ?? [];
    entry.push({ role, gemstoneType, nodeName: node.name ?? null });
    byMesh.set(node.mesh, entry);
  }
  return byMesh;
}

function resolvePrimitiveSemantic(gltf, meshIndex, mesh, primitive, nodeRoles) {
  const material = Number.isInteger(primitive.material)
    ? gltf.materials?.[primitive.material]
    : undefined;

  const candidates = [
    { source: 'mesh', role: roleFromExtras(mesh.extras), gemstoneType: normalizeText(mesh.extras?.gemstoneType) },
    { source: 'material', role: roleFromExtras(material?.extras), gemstoneType: normalizeText(material?.extras?.gemstoneType) },
    ...(nodeRoles.get(meshIndex) ?? []).map((entry) => ({
      source: `node:${entry.nodeName ?? '(unnamed)'}`,
      role: entry.role,
      gemstoneType: entry.gemstoneType,
    })),
  ].filter((entry) => entry.role);

  const roles = [...new Set(candidates.map((entry) => entry.role))];
  const types = [...new Set(candidates.map((entry) => entry.gemstoneType).filter(Boolean))];

  return {
    role: roles.length === 1 ? roles[0] : undefined,
    gemstoneType: types.length === 1 ? types[0] : undefined,
    conflict: roles.length > 1 || types.length > 1,
    sources: candidates,
  };
}

function materialHints(material) {
  const text = `${material?.name ?? ''}`.toLowerCase();
  const gemWords = ['gem', 'stone', 'diamond', 'sapphire', 'ruby', 'emerald', 'amethyst', 'crystal'];
  const metalWords = ['metal', 'silver', 'gold', 'platinum', 'steel', 'ring', 'band'];

  return {
    likelyGemstone: gemWords.some((word) => text.includes(word)),
    likelyMetal: metalWords.some((word) => text.includes(word)),
  };
}

function collectBounds(gltf) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let found = false;

  for (const mesh of gltf.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const accessorIndex = primitive.attributes?.POSITION;
      const accessor = Number.isInteger(accessorIndex) ? gltf.accessors?.[accessorIndex] : undefined;
      if (!Array.isArray(accessor?.min) || !Array.isArray(accessor?.max)) continue;
      if (accessor.min.length < 3 || accessor.max.length < 3) continue;

      found = true;
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], accessor.min[axis]);
        max[axis] = Math.max(max[axis], accessor.max[axis]);
      }
    }
  }

  if (!found) return null;

  return {
    min,
    max,
    size: max.map((value, axis) => value - min[axis]),
  };
}

const buffer = await readFile(inputPath);
const gltf = parseGlb(buffer);
const nodeRoles = collectNodeRoles(gltf);

let primitiveCount = 0;
let triangles = 0;
let explicitMetal = 0;
let explicitGemstone = 0;
let unknownSemantic = 0;
let semanticConflicts = 0;
const gemstoneTypes = new Set();
const primitiveDetails = [];

for (const [meshIndex, mesh] of (gltf.meshes ?? []).entries()) {
  for (const [primitiveIndex, primitive] of (mesh.primitives ?? []).entries()) {
    primitiveCount += 1;
    const primitiveTriangles = primitiveTriangleCount(gltf, primitive);
    triangles += primitiveTriangles;

    const semantic = resolvePrimitiveSemantic(gltf, meshIndex, mesh, primitive, nodeRoles);
    if (semantic.conflict) semanticConflicts += 1;
    if (semantic.role === 'metal') explicitMetal += 1;
    else if (semantic.role === 'gemstone') {
      explicitGemstone += 1;
      if (semantic.gemstoneType) gemstoneTypes.add(semantic.gemstoneType);
    } else {
      unknownSemantic += 1;
    }

    const material = Number.isInteger(primitive.material)
      ? gltf.materials?.[primitive.material]
      : undefined;

    primitiveDetails.push({
      meshIndex,
      meshName: mesh.name ?? null,
      primitiveIndex,
      triangles: primitiveTriangles,
      materialIndex: Number.isInteger(primitive.material) ? primitive.material : null,
      materialName: material?.name ?? null,
      explicitRole: semantic.role ?? null,
      gemstoneType: semantic.gemstoneType ?? null,
      semanticConflict: semantic.conflict,
      roleHints: materialHints(material),
    });
  }
}

const materials = (gltf.materials ?? []).map((material, index) => ({
  index,
  name: material.name ?? null,
  extras: material.extras ?? null,
  alphaMode: material.alphaMode ?? 'OPAQUE',
  doubleSided: material.doubleSided ?? false,
  metallicFactor: material.pbrMetallicRoughness?.metallicFactor ?? 1,
  roughnessFactor: material.pbrMetallicRoughness?.roughnessFactor ?? 1,
  hints: materialHints(material),
}));

const bounds = collectBounds(gltf);
const semanticReady =
  primitiveCount > 0
  && explicitMetal > 0
  && explicitGemstone > 0
  && unknownSemantic === 0
  && semanticConflicts === 0;

const issues = [];
if (primitiveCount === 0) issues.push({ severity: 'error', code: 'NO_PRIMITIVES', message: 'The GLB contains no mesh primitives.' });
if (triangles > 100_000) issues.push({ severity: 'warning', code: 'HEAVY_GEOMETRY', message: `Approximate triangle count is ${triangles.toLocaleString()}; simplify before mobile WebAR.` });
if (buffer.length > 20 * 1024 * 1024) issues.push({ severity: 'warning', code: 'LARGE_FILE', message: `GLB size is ${formatBytes(buffer.length)}; this is heavy for mobile delivery.` });
if ((gltf.materials?.length ?? 0) <= 1 && !semanticReady) issues.push({ severity: 'warning', code: 'SINGLE_MATERIAL', message: 'Metal and gemstone may be baked into one material; separate gemstone shading may not be possible automatically.' });
if (!semanticReady) issues.push({ severity: 'info', code: 'NOT_PRODUCTION_SEMANTIC', message: 'This AI-generated model is not yet eligible for assets/models/raw/ production semantic validation.' });

let verdict = 'PROTOTYPE_REVIEW';
if (semanticReady) verdict = 'SEMANTIC_READY';
else if ((gltf.materials?.length ?? 0) <= 1 && primitiveCount <= 1) verdict = 'NEEDS_SEPARATION';
else if (triangles > 100_000 || buffer.length > 20 * 1024 * 1024) verdict = 'NEEDS_OPTIMIZATION';

const report = {
  generatedAt: new Date().toISOString(),
  input: inputPath,
  fileName: basename(inputPath),
  verdict,
  fileBytes: buffer.length,
  fileSize: formatBytes(buffer.length),
  asset: gltf.asset ?? null,
  counts: {
    scenes: gltf.scenes?.length ?? 0,
    nodes: gltf.nodes?.length ?? 0,
    meshes: gltf.meshes?.length ?? 0,
    primitives: primitiveCount,
    materials: gltf.materials?.length ?? 0,
    textures: gltf.textures?.length ?? 0,
    images: gltf.images?.length ?? 0,
    approximateTriangles: triangles,
  },
  bounds,
  extensionsUsed: gltf.extensionsUsed ?? [],
  extensionsRequired: gltf.extensionsRequired ?? [],
  semantics: {
    productionReady: semanticReady,
    explicitMetalPrimitives: explicitMetal,
    explicitGemstonePrimitives: explicitGemstone,
    unknownPrimitives: unknownSemantic,
    conflicts: semanticConflicts,
    gemstoneTypes: [...gemstoneTypes].sort(),
  },
  materials,
  primitives: primitiveDetails,
  issues,
};

const markdown = `# AI ring model intake report\n\n`
  + `- **File:** \`${basename(inputPath)}\`\n`
  + `- **Verdict:** **${verdict}**\n`
  + `- **Size:** ${report.fileSize}\n`
  + `- **Meshes / primitives / materials:** ${report.counts.meshes} / ${report.counts.primitives} / ${report.counts.materials}\n`
  + `- **Approx. triangles:** ${triangles.toLocaleString()}\n`
  + `- **Textures / images:** ${report.counts.textures} / ${report.counts.images}\n`
  + `- **Explicit metal primitives:** ${explicitMetal}\n`
  + `- **Explicit gemstone primitives:** ${explicitGemstone}\n`
  + `- **Unknown semantic primitives:** ${unknownSemantic}\n`
  + `- **Production semantic ready:** ${semanticReady ? 'YES' : 'NO'}\n\n`
  + `## Materials\n\n`
  + (materials.length
    ? materials.map((material) => `- #${material.index} \`${material.name ?? '(unnamed)'}\` — metallic=${material.metallicFactor}, roughness=${material.roughnessFactor}`).join('\n')
    : '- No glTF materials declared.')
  + `\n\n## Issues\n\n`
  + (issues.length
    ? issues.map((issue) => `- **${issue.severity.toUpperCase()} ${issue.code}:** ${issue.message}`).join('\n')
    : '- No intake issues detected.')
  + `\n\n## Next step\n\n`
  + (semanticReady
    ? 'The file can move to the semantic release pipeline after visual review and scale/orientation verification.'
    : 'Keep this file in `assets/models/incoming/`. Review this report before creating explicit Metal/Gemstone semantic metadata or deciding whether geometry separation is required.')
  + `\n`;

await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile(resolve(outputDir, 'report.md'), markdown, 'utf8');

console.log(markdown);
