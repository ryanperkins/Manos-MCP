import type { Screen, UiElement } from "../drivers/types.js";

export type Severity = "error" | "warning";

export interface A11yFinding {
  rule: string;
  severity: Severity;
  message: string;
  element: { id: string; bounds: [number, number, number, number]; label: string };
}

export interface A11yReport {
  findings: A11yFinding[];
  summary: { errors: number; warnings: number; checked: number };
  minTouchTargetPx: number;
  notes: string[];
}

function labelOf(el: UiElement): string {
  return el.text || el.accessibility || el.value || el.resourceId || el.cls || "(unlabeled)";
}

function isInteractive(el: UiElement): boolean {
  return el.clickable || /button|switch|checkbox|link|tab|cell|textfield|edittext/i.test(el.cls ?? "");
}

/**
 * Heuristic accessibility audit over a captured screen. Catches the classes of
 * issue visible in a view hierarchy without pixel access: undersized touch
 * targets, unlabeled interactive controls, and duplicate accessibility labels.
 * (Color-contrast needs pixels and is out of scope here — noted, not faked.)
 */
export function auditScreen(screen: Screen): A11yReport {
  const notes: string[] = [];
  // iOS bounds are in points (min target 44pt). Android bounds are in px;
  // convert the 48dp guideline using density (default 160dpi = 1x).
  let minTouchTargetPx: number;
  if (screen.platform === "ios") {
    minTouchTargetPx = 44;
  } else {
    const dpi = screen.densityDpi ?? 160;
    if (!screen.densityDpi) notes.push("Android density unknown; assumed 160dpi (1x) for touch-target sizing.");
    minTouchTargetPx = Math.round(48 * (dpi / 160));
  }

  const findings: A11yFinding[] = [];
  const labelCounts = new Map<string, UiElement[]>();
  let checked = 0;

  for (const el of screen.flat) {
    if (!isInteractive(el)) continue;
    checked++;
    const ref = {
      id: el.id,
      bounds: [el.bounds.x, el.bounds.y, el.bounds.width, el.bounds.height] as [
        number,
        number,
        number,
        number,
      ],
      label: labelOf(el),
    };

    // Undersized touch target
    if (
      el.bounds.width > 0 &&
      el.bounds.height > 0 &&
      (el.bounds.width < minTouchTargetPx || el.bounds.height < minTouchTargetPx)
    ) {
      findings.push({
        rule: "touch-target-size",
        severity: "warning",
        message: `Interactive element is ${el.bounds.width}×${el.bounds.height}px, below the ${minTouchTargetPx}px minimum.`,
        element: ref,
      });
    }

    // Unlabeled interactive control
    const hasLabel = Boolean(el.text || el.accessibility || el.value);
    if (!hasLabel) {
      findings.push({
        rule: "missing-label",
        severity: "error",
        message: "Interactive element has no text, accessibility label, or value — invisible to screen readers.",
        element: ref,
      });
    } else {
      const key = (el.accessibility || el.text || "").toLowerCase();
      if (key) {
        const arr = labelCounts.get(key) ?? [];
        arr.push(el);
        labelCounts.set(key, arr);
      }
    }
  }

  // Duplicate labels among interactive elements
  for (const [label, els] of labelCounts) {
    if (els.length > 1) {
      const first = els[0]!;
      findings.push({
        rule: "duplicate-label",
        severity: "warning",
        message: `${els.length} interactive elements share the label "${label}" — ambiguous for assistive tech.`,
        element: {
          id: first.id,
          bounds: [first.bounds.x, first.bounds.y, first.bounds.width, first.bounds.height],
          label,
        },
      });
    }
  }

  notes.push("Color-contrast and font-size checks require pixel access and are not evaluated here.");

  return {
    findings,
    summary: {
      errors: findings.filter((f) => f.severity === "error").length,
      warnings: findings.filter((f) => f.severity === "warning").length,
      checked,
    },
    minTouchTargetPx,
    notes,
  };
}
