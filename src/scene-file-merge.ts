import { mergeSceneChange, sceneEqual, SceneData, SceneElement } from "./scene";

/** Reject competing edits rather than silently losing either writer's version. */
export function mergeSceneFile(
  base: SceneData | undefined,
  local: SceneData,
  disk: SceneData | undefined
): SceneData {
  if (!disk) {
    if (base) {
      throw new Error(
        "The drawing was removed externally; use Save As to preserve local edits."
      );
    }
    return local;
  }
  if (!base) {
    if (sceneEqual(local, disk)) {
      return local;
    }
    throw new Error(
      "The drawing has no disk baseline; use Save As or revert before overwriting it."
    );
  }
  const conflicts: string[] = [];
  const revisions = new Set(["version", "versionNonce", "updated"]);
  const checkFields = (
    before: Record<string, unknown>,
    current: Record<string, unknown>,
    incoming: Record<string, unknown>,
    prefix: string,
    excluded = new Set<string>()
  ) => {
    for (const key of new Set([
      ...Object.keys(before),
      ...Object.keys(current),
      ...Object.keys(incoming),
    ])) {
      if (
        !excluded.has(key) &&
        !sceneEqual(before[key], current[key]) &&
        !sceneEqual(before[key], incoming[key]) &&
        !sceneEqual(current[key], incoming[key])
      ) {
        conflicts.push(`${prefix}${key}`);
      }
    }
  };
  checkFields(
    base,
    local,
    disk,
    "",
    new Set(["elements", "appState", "files"])
  );
  checkFields(base.appState, local.appState, disk.appState, "appState.");
  checkFields(base.files, local.files, disk.files, "files.");
  const baseline = new Map(
    base.elements.map((element) => [element.id, element])
  );
  const working = new Map(
    local.elements.map((element) => [element.id, element])
  );
  const incoming = new Map(
    disk.elements.map((element) => [element.id, element])
  );
  const active = (element: SceneElement | undefined) =>
    element && !element.isDeleted;
  const changed = (before: SceneElement, after: SceneElement) =>
    [...new Set([...Object.keys(before), ...Object.keys(after)])].some(
      (key) => !revisions.has(key) && !sceneEqual(before[key], after[key])
    );
  for (const id of new Set([
    ...baseline.keys(),
    ...working.keys(),
    ...incoming.keys(),
  ])) {
    const before = baseline.get(id);
    const current = working.get(id);
    const next = incoming.get(id);
    if (active(before)) {
      // Deleting an object also conflicts with editing any of its properties.
      if (
        (!active(current) && active(next) && changed(before!, next!)) ||
        (!active(next) && active(current) && changed(before!, current!))
      ) {
        conflicts.push(`elements[${id}] (deletion versus edit)`);
        continue;
      }
    }
    if (current && next) {
      checkFields(before || {}, current, next, `elements[${id}].`, revisions);
    }
  }
  if (conflicts.length) {
    throw new Error(
      `External drawing changes conflict at ${conflicts.join(
        ", "
      )}. Neither version was overwritten. Use Save As to preserve local edits, or revert to load the disk version.`
    );
  }
  // Treat omissions as tombstones first, so an unchanged stale local snapshot
  // cannot resurrect an element removed from disk by a normal Excalidraw export.
  const remote = mergeSceneChange(base, base, disk);
  return mergeSceneChange(remote, base, local);
}

/** Validate the scene boundary before exposing it to an open canvas. */
export function parseSceneFile(content: Uint8Array): SceneData {
  const value = JSON.parse(new TextDecoder().decode(content));
  if (!value || value.type !== "excalidraw" || !Array.isArray(value.elements)) {
    throw new Error("The file is not an Excalidraw scene.");
  }
  const ids = new Set<string>();
  for (const element of value.elements) {
    if (
      !element ||
      typeof element !== "object" ||
      typeof element.id !== "string" ||
      ids.has(element.id) ||
      typeof element.type !== "string"
    ) {
      throw new Error(
        "The drawing contains invalid or duplicate element identities."
      );
    }
    ids.add(element.id);
  }
  for (const key of ["appState", "files"]) {
    if (
      value[key] !== undefined &&
      (!value[key] ||
        typeof value[key] !== "object" ||
        Array.isArray(value[key]))
    ) {
      throw new Error(`The drawing's ${key} must be an object.`);
    }
  }
  return { ...value, appState: value.appState || {}, files: value.files || {} };
}
