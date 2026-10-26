import { FONT_FAMILY, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

/** Native text measurement and optional row presentation for one editor scene. */
export class SceneTextLayout {
  private rowPresentation = new Map<
    string,
    {
      y: number;
      opacity: number;
      renderedY: number;
      renderedOpacity: number;
    }
  >();

  reset() {
    this.rowPresentation.clear();
  }

  /** Excalidraw registers its faces when mounting; load incoming scene fonts before measuring. */
  async loadFonts(
    elements: readonly ExcalidrawElement[],
    ownerDocument: Document
  ) {
    const requests = new Map<string, string>();
    for (const element of elements) {
      if (element.type !== "text" || element.isDeleted) continue;
      const family = Object.entries(FONT_FAMILY).find(
        ([, id]) => id === element.fontFamily
      )?.[0];
      if (!family) continue;
      const font = element.fontSize + 'px "' + family + '"';
      requests.set(font, (requests.get(font) || "") + element.originalText);
    }
    await Promise.all(
      Array.from(requests, ([font, text]) =>
        ownerDocument.fonts.load(font, text)
      )
    );
  }

  /** Persist user edits, not the row positions/visibility calculated for this viewport. */
  forPersistence(elements: readonly ExcalidrawElement[]) {
    return elements.map((element) => {
      const original = this.rowPresentation.get(element.id);
      if (!original) return element;
      return {
        ...element,
        y: element.y === original.renderedY ? original.y : element.y,
        opacity:
          element.opacity === original.renderedOpacity
            ? original.opacity
            : element.opacity,
      };
    });
  }

  /** Let Excalidraw measure external fixed-width text with its own fonts and wrapping. */
  refresh(
    elements: readonly ExcalidrawElement[],
    previous: readonly ExcalidrawElement[] = []
  ): readonly ExcalidrawElement[] {
    const previousById = new Map(
      previous.map((element) => [element.id, element])
    );
    const refreshIds = new Set(
      elements
        .filter(
          (element) =>
            element.type === "text" &&
            !element.isDeleted &&
            !element.autoResize &&
            element.width > 0 &&
            previousById.get(element.id) !== element
        )
        .map((element) => element.id)
    );
    if (!refreshIds.size) return this.layoutRows(elements);

    // Restoration can discard zero-size elements or repair indices/bindings. Use
    // it for measurement only, never to replace a live scene or its active drag.
    const measured = new Map(
      restoreElements(
        elements.map((element) =>
          element.type === "text" && refreshIds.has(element.id)
            ? { ...element, text: element.originalText ?? element.text }
            : element
        ),
        null,
        { repairBindings: true, refreshDimensions: true }
      ).map((element) => [element.id, element])
    );
    return this.layoutRows(
      elements.map((element) => {
        const text = measured.get(element.id);
        if (!refreshIds.has(element.id) || text?.type !== "text")
          return element;
        return {
          ...element,
          text: text.text,
          index: text.index,
          x: text.x,
          y: text.y,
          width: text.width,
          height: text.height,
        };
      })
    );
  }

  /** Optional generic presentation: native text measurement followed by grouped rows. */
  private layoutRows(
    elements: readonly ExcalidrawElement[]
  ): readonly ExcalidrawElement[] {
    this.rowPresentation.clear();
    const replacements = new Map<string, ExcalidrawElement>();
    for (const frame of elements) {
      if (frame.type !== "frame" || frame.isDeleted || frame.angle !== 0)
        continue;
      const layout = frame.customData?.layout;
      if (
        !layout ||
        typeof layout !== "object" ||
        layout.type !== "rows" ||
        !Array.isArray(layout.groups) ||
        !layout.groups.every((id: unknown) => typeof id === "string") ||
        ![layout.top, layout.bottom, layout.gap].every(
          (value) =>
            typeof value === "number" && Number.isFinite(value) && value >= 0
        )
      )
        continue;
      const groupIds = Array.from(new Set<string>(layout.groups));
      const rows = groupIds
        .map((id) => {
          const members = elements.filter(
            (element) =>
              !element.isDeleted &&
              element.frameId === frame.id &&
              element.groupIds.includes(id)
          );
          return {
            members,
            height: Math.max(0, ...members.map((element) => element.height)),
          };
        })
        .filter((row) => row.members.length);
      const available = Math.max(0, frame.height - layout.top - layout.bottom);
      let first = rows.length;
      let used = 0;
      for (let index = rows.length - 1; index >= 0; index--) {
        const needed =
          rows[index].height + (first < rows.length ? layout.gap : 0);
        if (used + needed > available && first < rows.length) break;
        first = index;
        used += needed;
        if (used > available) break; // Keep an oversized latest row, clipped by its native frame.
      }
      let y = frame.y + layout.top;
      for (const [index, row] of rows.entries()) {
        for (const element of row.members) {
          const rendered = {
            ...element,
            y: index < first ? element.y : y,
            opacity: index < first ? 0 : element.opacity,
          };
          replacements.set(element.id, rendered);
          this.rowPresentation.set(element.id, {
            y: element.y,
            opacity: element.opacity,
            renderedY: rendered.y,
            renderedOpacity: rendered.opacity,
          });
        }
        if (index >= first) y += row.height + layout.gap;
      }
    }
    return replacements.size
      ? elements.map((element) => replacements.get(element.id) || element)
      : elements;
  }
}
