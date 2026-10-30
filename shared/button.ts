// The frantss.uy button (Frantss/frantssuy design-system/components.css), drawn with GPUI.
// Mods can't import outside their own folder, so each mod links this file as ./button.ts
// and the build emits a copy into every mod that links it.
import type { Color, Context, Element } from "gpui-kit";

import { Button } from "gpui-base";
import { settings, theme } from "herdr";

export type ButtonVariant = "secondary" | "primary" | "quiet";

export interface ButtonOptions {
  variant?: ButtonVariant;
  // Toolbars use "compact"; the site's own height is "regular".
  size?: "compact" | "regular";
  // Square, for an icon instead of text.
  square?: boolean;
  disabled?: boolean;
  tooltip?: string;
}

const HEIGHT = { compact: 24, regular: 34 };
const PADDING = { compact: 8, regular: 12 };
// The site's darker bottom edge under primary buttons; no theme color holds it.
const ACCENT_EDGE = { dark: "#7c5fd6", light: "#4c1d95" } as const;

export function button(
  id: string,
  label: Element | string,
  action: (cx: Context) => void,
  {
    variant = "secondary",
    size = "compact",
    square = false,
    disabled = false,
    tooltip,
  }: ButtonOptions = {},
) {
  const t = theme() as Record<string, Color>,
    height = HEIGHT[size],
    accentEdge = settings().dark ? ACCENT_EDGE.dark : ACCENT_EDGE.light,
    quiet = variant === "quiet",
    primary = variant === "primary",
    border = quiet ? "#00000000" : primary ? accentEdge : t.input,
    accessibleName = tooltip ?? (typeof label === "string" ? label : undefined);
  // GPUI draws one border color, so the site's bottom edge takes the border's color.
  return Button.new(id)
    .tab_stop(true)
    .h(height)
    .when(square, (el) => el.w(height))
    .when(!square, (el) => el.px(quiet ? 8 : PADDING[size]))
    .flex()
    .flex_none()
    .items_center()
    .justify_center()
    .gap(4)
    .rounded(3)
    .border_1()
    .when(!quiet && !disabled, (el) => el.border_b(2).active((s) => s.border_b(1)))
    .border_color(border)
    .bg(quiet ? "#00000000" : primary ? t.accent : t.surface)
    .text_size(12)
    .text_color(quiet ? t.muted : primary ? t.accent_foreground : t.foreground)
    .when(primary, (el) => el.font_bold())
    .when(!primary, (el) => el.font_medium())
    .when(disabled, (el) =>
      el
        .border_color(quiet ? "#00000000" : t.border)
        .bg(primary ? t.border : "#00000000")
        .text_color(t.muted),
    )
    .disabled(disabled)
    .when(!disabled, (el) =>
      el.cursor_pointer().hover((s) => {
        if (quiet) s.text_color(t.foreground).underline();
        else if (primary) s.bg(`${t.accent}d9`);
        else s.border_color(t.muted).bg(t.hover);
      }),
    )
    .focus((el) => el.border_color(t.accent))
    .when(Boolean(tooltip), (el) => el.tooltip(tooltip))
    .when(Boolean(accessibleName), (el) => el.accessibility_label(accessibleName))
    .on_click((_e, cx) => {
      cx.stop_propagation();
      action(cx);
    })
    .child(label);
}
