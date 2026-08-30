import { Ph, callout, h3, list, p, type Section } from "@/components/legal/content";
import { ACCESSIBILITY_CONTACT_EMAIL, LEGAL_COMPANY_NAME } from "@/lib/legal-config";

/* ==========================================================================
   ACCESSIBILITY STATEMENT

   Every measure listed below is one that actually exists in this codebase after
   the accessibility pass. Nothing here claims a certification, an audit or a
   conformance level that has not been carried out — WCAG 2.2 AA is described as
   the target we work to, not as an achieved and verified result.
   ========================================================================== */

export function accessibilitySectionsEn(): Section[] {
  return [
    {
      id: "commitment",
      title: "Our Commitment",
      blocks: [
        p(
          <>
            <Ph>{LEGAL_COMPANY_NAME}</Ph> wants ClipRewards to be usable by as many people as
            possible, including people who navigate by keyboard, use a screen reader or other
            assistive technology, need larger text or stronger contrast, or prefer less motion on
            screen.
          </>,
        ),
        p(
          "We work to the Web Content Accessibility Guidelines (WCAG) 2.2 at Level AA as our technical target. That is the standard we build and test against — not a claim that every page has been independently audited or certified against it.",
        ),
        p(
          "Accessibility is treated as part of building the product rather than as a one-off exercise, and it is checked again whenever we ship a new section.",
        ),
      ],
    },
    {
      id: "measures",
      title: "Accessibility Measures in Place",
      blocks: [
        p("The following are built into the site today:"),
  
        h3("Structure and semantics"),
        list([
          "each page uses landmark regions — a banner, a main region, navigation and a footer — so assistive technology can jump between them;",
          "each page has a single main heading, and headings descend in order without skipping levels;",
          "interactive controls are real buttons, links, inputs and selects rather than styled containers, so they behave the way assistive technology expects;",
          "navigation regions carry names, so multiple menus on one page can be told apart.",
        ]),
  
        h3("Keyboard"),
        list([
          "a “Skip to main content” link is the first thing keyboard focus reaches on every page;",
          "every interactive control can be reached and operated from the keyboard alone;",
          "focus is always visible — one consistent focus ring is used across both the creator and brand experiences;",
          "the mobile menu, the filter dropdowns and the accessibility panel all close on Escape and return focus to the control that opened them;",
          "accordions open with Enter or Space, the FAQ audience tabs move with the arrow keys, and the carousels can be driven with the arrow keys;",
          "carousel dots and other small controls have touch and pointer targets of at least 24 by 24 pixels.",
        ]),
  
        h3("Content and media"),
        list([
          "images that carry meaning have text alternatives; images that are purely decorative are hidden from assistive technology instead of being described;",
          "icon-only controls — carousel arrows, the menu button, social links, close buttons — all carry an accessible name;",
          "state such as “selected”, “expanded”, “current” and “required” is exposed programmatically, not signalled by colour alone;",
          "form fields have real labels; placeholder text is never used in place of one;",
          "validation errors are announced, described in words, associated with their field, and marked with an icon as well as colour, and focus moves to the first field that needs attention.",
        ]),
  
        h3("Presentation and motion"),
        list([
          "text and interface colours have been adjusted where they did not meet the WCAG AA contrast minimum, in both the light and dark experiences;",
          "the site honours the operating system's “reduce motion” setting: decorative floating, drifting and glowing animations stop, and smooth scrolling is switched off;",
          "auto-scrolling decorative elements pause when a pointer or keyboard focus reaches them.",
        ]),
      ],
    },
    {
      id: "options-menu",
      title: "The Accessibility Options Menu",
      blocks: [
        p(
          "Every page carries a floating accessibility button in the lower-left corner. It opens a small panel with display preferences you can set for yourself:",
        ),
        list([
          "Text size — normal, large or extra large;",
          "Higher contrast — strengthens muted text and borders;",
          "Highlight links — underlines every link on the page;",
          "Reduce motion — stops decorative animation and smooth scrolling, even if your device setting is off;",
          "Reset all — returns everything to its default.",
        ]),
        p(
          "Your choices are stored in your browser on this device only. They are never sent to us, and they survive refreshing the page and moving between pages.",
        ),
        callout(
          "This menu is a convenience layer on top of the accessibility work described above — it is not a substitute for it, and turning it off does not make the site less accessible. It also cannot make a page conformant on its own, and we do not present it as doing so.",
        ),
        p(
          "We deliberately do not offer a “screen reader mode” or built-in text-to-speech. The site is built to work with the screen reader, magnifier or voice control you already use, and adding a parallel imitation of one tends to get in the way of the real thing.",
        ),
      ],
    },
    {
      id: "known-limitations",
      title: "Known Limitations",
      blocks: [
        p(
          "We are not claiming the site is free of accessibility problems. Areas we are aware of:",
        ),
        list([
          "the site has been checked with automated tooling and manual keyboard testing, but it has not yet been through a full audit with assistive technology users or an independent accessibility assessor;",
          "some sections are built around large decorative compositions; these are hidden from assistive technology and the surrounding text carries their meaning, but the visual experience is richer than the text-only one;",
          "increasing the text size scales the whole page, which on small screens means more scrolling;",
          "parts of the product are still being built, and new sections may briefly fall short of the standard before the next accessibility check;",
          "we have not yet published a conformance report, so no page here should be treated as formally verified.",
        ]),
        p(
          "If you hit something that is not covered above, we would like to hear about it — that is usually how these get found.",
        ),
      ],
    },
    {
      id: "third-party",
      title: "Third-Party Content and Services",
      blocks: [
        p(
          "Some parts of the experience depend on services operated by other companies — for example the sign-in provider, the account-linking provider, and the social platforms where campaign content is published.",
        ),
        p(
          "We do not control the accessibility of those services or of content hosted on them, and their behaviour may differ from ours. Where a third-party step blocks you, contact us and we will look for another way to help you complete it.",
        ),
      ],
    },
    {
      id: "feedback",
      title: "Feedback and Assistance",
      blocks: [
        p(
          <>
            If you have trouble using any part of ClipRewards, or you need information from this site
            in a different format, contact us at <Ph>{ACCESSIBILITY_CONTACT_EMAIL}</Ph>.
          </>,
        ),
        p(
          "It helps if you can tell us the page you were on, what you were trying to do, and the browser and assistive technology you were using — but please get in touch either way rather than not at all.",
        ),
        p(
          "We aim to acknowledge accessibility reports promptly and to tell you what we intend to do about them.",
        ),
        callout(
          "The address above is a placeholder held in one place in our codebase and will be completed before launch.",
        ),
      ],
    },
  ];
}
