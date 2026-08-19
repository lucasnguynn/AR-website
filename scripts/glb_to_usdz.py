# FILE: scripts/glb_to_usdz.py
"""Convert a GLB mesh into a minimal USDZ package for Apple AR Quick Look."""

from __future__ import annotations

import argparse
import json
import struct
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


GLB_MAGIC = 0x46546C67
JSON_CHUNK_TYPE = 0x4E4F534A
BIN_CHUNK_TYPE = 0x004E4942
COMPONENT_FORMATS = {
    5120: ("b", 1),
    5121: ("B", 1),
    5122: ("h", 2),
    5123: ("H", 2),
    5125: ("I", 4),
    5126: ("f", 4),
}
TYPE_COUNTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


@dataclass(frozen=True)
class GlbDocument:
    """Parsed GLB JSON and binary payload."""

    json_doc: dict[str, object]
    binary: bytes


def read_glb(path: Path) -> GlbDocument:
    """Read the JSON and BIN chunks from a GLB file."""
    data = path.read_bytes()
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC or version != 2 or length != len(data):
        raise ValueError(f"{path} is not a valid GLB v2 file")

    offset = 12
    json_doc: dict[str, object] | None = None
    binary = b""
    while offset < len(data):
        chunk_length, chunk_type = struct.unpack_from("<II", data, offset)
        offset += 8
        chunk = data[offset : offset + chunk_length]
        offset += chunk_length
        if chunk_type == JSON_CHUNK_TYPE:
            loaded = json.loads(chunk.decode("utf-8"))
            if not isinstance(loaded, dict):
                raise ValueError("GLB JSON chunk must be an object")
            json_doc = loaded
        elif chunk_type == BIN_CHUNK_TYPE:
            binary = chunk

    if json_doc is None:
        raise ValueError(f"{path} does not contain a JSON chunk")
    return GlbDocument(json_doc=json_doc, binary=binary)


def object_list(doc: dict[str, object], key: str) -> list[dict[str, object]]:
    """Return a typed list of dictionaries from a glTF top-level key."""
    value = doc.get(key, [])
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def accessor_values(glb: GlbDocument, accessor_index: int) -> list[tuple[float, ...]]:
    """Decode accessor data as tuples of numeric values."""
    accessors = object_list(glb.json_doc, "accessors")
    buffer_views = object_list(glb.json_doc, "bufferViews")
    accessor = accessors[accessor_index]
    view_index = int(accessor.get("bufferView", 0))
    view = buffer_views[view_index]
    component_type = int(accessor["componentType"])
    accessor_type = str(accessor["type"])
    count = int(accessor["count"])
    fmt, byte_size = COMPONENT_FORMATS[component_type]
    components = TYPE_COUNTS[accessor_type]
    stride = int(view.get("byteStride", byte_size * components))
    base_offset = int(view.get("byteOffset", 0)) + int(accessor.get("byteOffset", 0))
    unpack = struct.Struct("<" + fmt * components)
    return [tuple(float(value) for value in unpack.unpack_from(glb.binary, base_offset + (index * stride))) for index in range(count)]


def scalar_indices(glb: GlbDocument, accessor_index: int) -> list[int]:
    """Decode an index accessor into integer scalar indices."""
    return [int(values[0]) for values in accessor_values(glb, accessor_index)]


def triples(indices: list[int]) -> Iterable[tuple[int, int, int]]:
    """Yield triangle index triples."""
    for offset in range(0, len(indices) - 2, 3):
        yield indices[offset], indices[offset + 1], indices[offset + 2]


def convert(glb_path: Path) -> Path:
    """Convert GLB triangles to a self-contained, uncompressed USDZ package."""
    glb = read_glb(glb_path)
    meshes = object_list(glb.json_doc, "meshes")
    lines = ["#usda 1.0", "(", '    defaultPrim = "Root"', '    metersPerUnit = 1', '    upAxis = "Y"', ")", 'def Xform "Root" {']
    mesh_number = 0
    for mesh_doc in meshes:
        primitives = mesh_doc.get("primitives", [])
        if not isinstance(primitives, list):
            continue
        for primitive in primitives:
            if not isinstance(primitive, dict):
                continue
            attributes = primitive.get("attributes", {})
            if not isinstance(attributes, dict) or "POSITION" not in attributes:
                continue
            points = accessor_values(glb, int(attributes["POSITION"]))
            indices = scalar_indices(glb, int(primitive["indices"])) if "indices" in primitive else list(range(len(points)))
            indices = [index for tri in triples(indices) for index in tri]
            lines.extend([f'    def Mesh "Mesh_{mesh_number}" {{', f'        int[] faceVertexCounts = [{", ".join("3" for _ in range(len(indices) // 3))}]', f'        int[] faceVertexIndices = [{", ".join(map(str, indices))}]', f'        point3f[] points = [{", ".join(f"({v[0]:.7g}, {v[1]:.7g}, {v[2]:.7g})" for v in points)}]', '        uniform token subdivisionScheme = "none"', "    }"])
            mesh_number += 1
    lines.append("}")
    if mesh_number == 0:
        raise ValueError(f"{glb_path} contains no convertible mesh primitives")
    payload = ("\n".join(lines) + "\n").encode("utf-8")
    usdz_path = glb_path.with_suffix(".usdz")
    info = zipfile.ZipInfo("model.usda")
    info.compress_type = zipfile.ZIP_STORED
    # USDZ requires each file payload to begin on a 64-byte boundary.
    base_header_size = 30 + len(info.filename.encode("utf-8"))
    padding = (-base_header_size) % 64
    if padding:
        info.extra = b"\x00\x00" + struct.pack("<H", padding - 4) + (b"\x00" * (padding - 4))
    with zipfile.ZipFile(usdz_path, "w") as archive:
        archive.writestr(info, payload)
    return usdz_path


def main() -> int:
    """CLI entrypoint for GLB-to-USDZ conversion."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("glb", type=Path, help="Path to a GLB model")
    args = parser.parse_args()
    output_path = convert(args.glb)
    print(f"Created {output_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
# VERIFY: print("glb_to_usdz.py converts GLB mesh primitives into USDZ Quick Look packages")
