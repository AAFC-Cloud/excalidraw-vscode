/** The persisted, JSON-compatible scene exchanged between editor panes. */
export interface SceneData {
  elements: SceneElement[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SceneElement {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  [key: string]: unknown;
}

export function sceneEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        sceneEqual(leftRecord[key], rightRecord[key])
    )
  );
}

/** Apply only fields changed by this pane, retaining edits made in other panes. */
function mergeFields(
  current: Record<string, unknown>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  excluded: Set<string> = new Set()
): Record<string, unknown> {
  const merged = { ...current };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (excluded.has(key) || sceneEqual(before[key], after[key])) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(after, key)) {
      merged[key] = after[key];
    } else {
      delete merged[key];
    }
  }
  return merged;
}

const elementRevisionFields = new Set(["version", "versionNonce", "updated"]);

function mergeElement(
  current: SceneElement | undefined,
  before: SceneElement | undefined,
  after: SceneElement
): SceneElement {
  if (!current) {
    return after;
  }
  const merged = mergeFields(
    current,
    before ?? {},
    after,
    elementRevisionFields
  ) as SceneElement;
  if (sceneEqual(current, merged)) {
    return current;
  }
  // A combination of edits is a new revision. Its version must exceed either
  // contributor so Excalidraw does not mistake it for an older element.
  const combined = !sceneEqual(
    mergeFields(after, after, merged, elementRevisionFields),
    after
  );
  merged.version = combined
    ? Math.max(current.version, after.version) + 1
    : Math.max(current.version + 1, after.version);
  merged.versionNonce = after.versionNonce;
  if (typeof after.updated === "number") {
    merged.updated = Math.max(
      typeof current.updated === "number" ? current.updated : 0,
      after.updated
    );
  }
  return merged;
}

function mergeOrder(
  current: SceneElement[],
  before: SceneElement[],
  after: SceneElement[],
  elements: Map<string, SceneElement>
): SceneElement[] {
  const order = current.map((element) => element.id);
  const beforeIds = new Set(before.map((element) => element.id));
  const afterIds = new Set(after.map((element) => element.id));
  const sharedBefore = before
    .filter((element) => afterIds.has(element.id))
    .map((element) => element.id);
  const sharedAfter = after
    .filter((element) => beforeIds.has(element.id))
    .map((element) => element.id);

  // A stale pane that only changes content must not undo a concurrent reorder.
  // For legacy scenes without indices, apply an explicit reorder to the slots
  // shared by both snapshots, retaining concurrently added elements in place.
  if (!sceneEqual(sharedBefore, sharedAfter)) {
    const reordered = new Set(sharedAfter);
    let next = 0;
    for (let index = 0; index < order.length; index++) {
      if (reordered.has(order[index])) {
        order[index] = sharedAfter[next++];
      }
    }
  }
  const present = new Set(order);
  for (let index = 0; index < after.length; index++) {
    const id = after[index].id;
    if (present.has(id)) {
      continue;
    }
    const predecessor = index > 0 ? order.indexOf(after[index - 1].id) : -1;
    const successor = after
      .slice(index + 1)
      .map((element) => order.indexOf(element.id))
      .find((position) => position >= 0);
    const position =
      predecessor >= 0 ? predecessor + 1 : successor ?? order.length;
    order.splice(position, 0, id);
    present.add(id);
  }
  // Include tombstones absent from both the current and incoming arrays.
  for (const id of elements.keys()) {
    if (!present.has(id)) {
      order.push(id);
    }
  }
  const result = order.map((id) => elements.get(id)!);
  const hasIndices = result.every(
    (element) => typeof element.index === "string"
  );
  const incomingIndicesOrdered = after.every(
    (element, index) =>
      typeof element.index === "string" &&
      (index === 0 || String(after[index - 1].index) < element.index)
  );
  if (hasIndices && incomingIndicesOrdered) {
    // Current Excalidraw versions encode stacking order in fractional indices.
    // Deltas leave unchanged indices intact, so independent insertions and
    // reorders can be combined without borrowing a stale pane's array order.
    result.sort((left, right) => {
      if (left.index === right.index) {
        return 0;
      }
      return String(left.index) < String(right.index) ? -1 : 1;
    });
  }
  return result;
}

/**
 * Merge a pane's before/after edit into the latest shared document.
 *
 * This is a three-way merge, not replacement with the pane's whole snapshot.
 * Independent fields survive concurrent edits. Conflicting edits to the same
 * field use arrival order. A stale edit cannot resurrect a deleted element;
 * undoing deletion must explicitly change isDeleted from true to false.
 */
export function mergeSceneChange(
  current: SceneData,
  before: SceneData,
  after: SceneData
): SceneData {
  const elements = new Map(
    current.elements.map((element) => [element.id, element])
  );
  const previous = new Map(
    before.elements.map((element) => [element.id, element])
  );
  const incoming = new Map(
    after.elements.map((element) => [element.id, element])
  );
  for (const element of after.elements) {
    elements.set(
      element.id,
      mergeElement(elements.get(element.id), previous.get(element.id), element)
    );
  }
  for (const element of before.elements) {
    if (!incoming.has(element.id)) {
      const existing = elements.get(element.id) ?? element;
      if (!existing.isDeleted) {
        elements.set(element.id, {
          ...existing,
          isDeleted: true,
          version: Math.max(existing.version, element.version) + 1,
          versionNonce: (existing.versionNonce + 1) % 2147483647,
        });
      }
    }
  }
  const files = { ...current.files };
  // Do not remove files based on a stale pane's snapshot: another pane may have
  // added an image using them. Excalidraw's export prunes unreferenced assets.
  for (const [id, file] of Object.entries(after.files)) {
    if (!sceneEqual(before.files[id], file)) {
      files[id] = file;
    }
  }
  return {
    ...mergeFields(
      current,
      before,
      after,
      new Set(["elements", "appState", "files"])
    ),
    elements: mergeOrder(
      current.elements,
      before.elements,
      after.elements,
      elements
    ),
    appState: mergeFields(current.appState, before.appState, after.appState),
    files,
  };
}
