type FieldMetadata = {
  name: string;
  baseType: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldMetadataRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];

  for (const key of ["fields", "dimensions", "columns", "result_metadata", "data"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function parseFieldMetadata(value: unknown): FieldMetadata[] {
  return fieldMetadataRows(value).flatMap((rawField) => {
    if (!isRecord(rawField) || typeof rawField.name !== "string") return [];
    const baseType = rawField.base_type ?? rawField["base-type"];
    if (typeof baseType !== "string" || !baseType.startsWith("type/") || baseType.length === 5) {
      return [];
    }

    return [{ name: rawField.name, baseType }];
  });
}

export function containsStringFieldReference(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return isRecord(value) &&
      Object.values(value).some(containsStringFieldReference);
  }
  if (value[0] === "field" && typeof value[2] === "string") return true;
  return value.some(containsStringFieldReference);
}

export function addFieldBaseTypes<T>(query: T, rawMetadata: unknown): T {
  if (!containsStringFieldReference(query)) return query;

  const fields = parseFieldMetadata(rawMetadata);
  if (fields.length === 0) {
    throw new Error("Cannot resolve string field references without field metadata");
  }

  const fieldsByName = new Map<string, FieldMetadata>();
  const ambiguousNames = new Set<string>();
  for (const field of fields) {
    if (fieldsByName.has(field.name)) {
      ambiguousNames.add(field.name);
    } else {
      fieldsByName.set(field.name, field);
    }
  }

  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      if (value[0] === "field" && typeof value[2] === "string") {
        const name = value[2];
        if (!isRecord(value[1])) {
          throw new Error(`Field reference "${name}" must have an options object`);
        }
        if (ambiguousNames.has(name)) {
          throw new Error(`Field reference "${name}" is ambiguous in the source metadata`);
        }
        const field = fieldsByName.get(name);
        if (!field) {
          throw new Error(`Field reference "${name}" was not found in the source metadata`);
        }

        return [
          value[0],
          { ...value[1], "base-type": field.baseType },
          ...value.slice(2).map(visit),
        ];
      }
      return value.map(visit);
    }
    if (!isRecord(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, visit(nestedValue)]),
    );
  };

  return visit(query) as T;
}
