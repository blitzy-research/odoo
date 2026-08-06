/*!
 * blitzy-techdocs.js — repository-owned behavioural corrections to the
 * published Material for MkDocs 9.7.6 theme chrome.
 *
 * Each block closes a specific, measured runtime defect that cannot be reached
 * from site configuration because the markup or behaviour concerned is emitted
 * by the third-party theme. The script is deliberately dependency-free, runs
 * after the theme bundle, mutates nothing that carries content, and degrades to
 * the unmodified theme if any single block throws.
 *
 *   1. Navigation drawer — keyboard operation, Escape, focus trap and restore,
 *      background scroll lock, off-screen focus containment, and state reset on
 *      back/forward-cache restoration.
 *   2. Current-item state — aria-current on the active navigation and
 *      table-of-contents links.
 *   3. Table-of-contents follow — keep the active entry inside its pane.
 *   4. Accessible names — heading permalinks, decorative icons.
 *   5. Landmarks — de-duplicate the contents tree rendered twice.
 *   6. Scrollable regions — keyboard-reachable, named, with header-cell scope
 *      and an injected caption for every data table.
 */
(function () {
  "use strict";

  /* ---------------------------------------------------------------- utils */

  var root = document.documentElement;

  function all(selector, context) {
    return Array.prototype.slice.call(
      (context || document).querySelectorAll(selector)
    );
  }

  function guard(name, fn) {
    try {
      fn();
    } catch (error) {
      /* A failure here must never take the page down with it: the theme
       * remains usable in its unmodified form. Surfaced as a warning so that
       * a regression is visible without being fatal. */
      if (window.console && window.console.warn) {
        window.console.warn("[blitzy-techdocs] " + name + " skipped:", error);
      }
    }
  }

  function prefersReducedMotion() {
    return (
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  /* Collapse whitespace and clip an accessible name to a length a screen
   * reader user can actually consume. Chrome derives the name of an
   * unlabelled scroll container from its entire text content, which produced a
   * 1,472-character announcement on the widest code block. */
  function shortLabel(text, limit) {
    var clean = String(text || "")
      .replace(/\s+/g, " ")
      .trim();
    if (clean.length > limit) {
      clean = clean.slice(0, limit - 1).replace(/[\s,;:.\-—]+$/, "") + "…";
    }
    return clean;
  }

  var FOCUSABLE =
    'a[href],area[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),' +
    'select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

  function visibleFocusable(container) {
    return all(FOCUSABLE, container).filter(function (el) {
      return el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement;
    });
  }

  /* ------------------------------------------------------------------ *
   * 1. Navigation drawer
   *
   * The theme's trigger is a bare <label for="__drawer">: absent from the tab
   * order and from the accessibility tree, with no expanded state, no Escape
   * handling, no focus management and no background scroll lock. Its links
   * remain focusable while the drawer is closed, so keyboard focus walks
   * off-screen. And because the open state lives in a checkbox, a
   * back/forward-cache restoration brings the drawer back open with its
   * scrim active, blocking the page.
   *
   * The label element is kept — it is what makes the control work for pointer
   * users without scripting — and everything else is added around it.
   * ------------------------------------------------------------------ */
  guard("drawer", function () {
    var toggle = document.getElementById("__drawer");
    var trigger = document.getElementById("blitzy-drawer-toggle");
    var drawer = document.querySelector(".md-sidebar--primary");
    if (!toggle || !trigger || !drawer) {
      return;
    }

    if (!drawer.id) {
      drawer.id = "blitzy-drawer";
    }
    trigger.setAttribute("aria-controls", drawer.id);

    var scrollwrap = drawer.querySelector(".md-sidebar__scrollwrap");
    var lastFocused = null;
    var lockedScrollY = 0;

    /* The drawer only exists as an overlay below Material's 76.25em
     * breakpoint; above it the same element is a static sidebar that must stay
     * reachable and must never be made inert or trap focus. */
    var overlayQuery = window.matchMedia("(max-width: 76.234375em)");

    function isOverlay() {
      return overlayQuery.matches;
    }

    function isOpen() {
      return toggle.checked && isOverlay();
    }

    function lockBackground() {
      lockedScrollY = window.scrollY || window.pageYOffset || 0;
      root.style.overflow = "hidden";
      root.style.touchAction = "none";
    }

    function unlockBackground() {
      root.style.overflow = "";
      root.style.touchAction = "";
    }

    function syncState() {
      var open = isOpen();
      trigger.setAttribute("aria-expanded", open ? "true" : "false");
      trigger.setAttribute(
        "aria-label",
        open ? "Close navigation menu" : "Open navigation menu"
      );
      /* Focus must not be able to enter the drawer while it is off-screen.
       * `inert` removes its contents from the tab order and from the
       * accessibility tree at the same time, which also resolves the
       * duplicated contents landmarks at overlay widths. */
      if ("inert" in HTMLElement.prototype) {
        drawer.inert = isOverlay() && !open;
      }
    }

    function openDrawer() {
      if (!isOverlay()) {
        return;
      }
      lastFocused = document.activeElement;
      toggle.checked = true;
      syncState();
      lockBackground();
      var focusable = visibleFocusable(drawer);
      if (focusable.length) {
        focusable[0].focus();
      } else {
        drawer.setAttribute("tabindex", "-1");
        drawer.focus();
      }
    }

    function closeDrawer(restoreFocus) {
      toggle.checked = false;
      syncState();
      unlockBackground();
      if (restoreFocus) {
        var target = lastFocused && document.contains(lastFocused) ? lastFocused : trigger;
        if (target && target.focus) {
          target.focus();
        }
      }
      lastFocused = null;
      /* Reset the pane's own scroll position too: a hidden traversal of the
       * off-screen links used to leave it scrolled sideways, so the drawer
       * reopened showing a blank column. */
      if (scrollwrap) {
        scrollwrap.scrollLeft = 0;
      }
      window.scrollTo(0, lockedScrollY || window.scrollY || 0);
    }

    /* Keyboard activation of the label. */
    trigger.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        if (isOpen()) {
          closeDrawer(true);
        } else {
          openDrawer();
        }
      }
    });

    /* Pointer activation goes through the native label→checkbox binding, so
     * the state change is observed rather than intercepted. */
    toggle.addEventListener("change", function () {
      if (isOpen()) {
        if (!lastFocused) {
          lastFocused = trigger;
        }
        syncState();
        lockBackground();
      } else {
        syncState();
        unlockBackground();
      }
    });

    /* Escape dismisses and returns focus to the trigger. The theme bundle
     * contains no Escape branch for the drawer at all. */
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && isOpen()) {
        event.preventDefault();
        event.stopPropagation();
        closeDrawer(true);
      }
    });

    /* Focus containment while open. */
    document.addEventListener(
      "keydown",
      function (event) {
        if (event.key !== "Tab" || !isOpen()) {
          return;
        }
        var focusable = visibleFocusable(drawer);
        if (!focusable.length) {
          return;
        }
        focusable.unshift(trigger);
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        var active = document.activeElement;
        if (event.shiftKey && (active === first || !drawer.contains(active))) {
          if (active !== trigger || event.shiftKey) {
            event.preventDefault();
            last.focus();
          }
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      },
      true
    );

    /* Back/forward-cache restoration. `pagehide` closes the drawer before the
     * page is frozen so that a restored page can never come back with an open
     * drawer and an active scrim; `pageshow` with `persisted` handles the case
     * where the browser restores the checkbox state anyway. */
    window.addEventListener("pagehide", function () {
      if (toggle.checked) {
        closeDrawer(false);
      }
    });

    window.addEventListener("pageshow", function (event) {
      if (event.persisted || toggle.checked) {
        closeDrawer(false);
        if (scrollwrap) {
          scrollwrap.scrollLeft = 0;
        }
      }
      syncState();
    });

    /* Crossing the breakpoint changes whether the drawer is an overlay. */
    var onQueryChange = function () {
      if (!isOverlay()) {
        unlockBackground();
      }
      syncState();
    };
    if (overlayQuery.addEventListener) {
      overlayQuery.addEventListener("change", onQueryChange);
    } else if (overlayQuery.addListener) {
      overlayQuery.addListener(onQueryChange);
    }

    /* The search trigger is the same kind of label and needs the same
     * treatment, minus the trap: the theme already handles Escape for it. */
    var searchToggle = document.getElementById("__search");
    var searchTrigger = document.getElementById("blitzy-search-toggle");
    if (searchToggle && searchTrigger) {
      var syncSearch = function () {
        searchTrigger.setAttribute(
          "aria-expanded",
          searchToggle.checked ? "true" : "false"
        );
      };
      searchTrigger.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
          event.preventDefault();
          searchToggle.checked = !searchToggle.checked;
          searchToggle.dispatchEvent(new Event("change", { bubbles: true }));
          syncSearch();
          if (searchToggle.checked) {
            var input = document.querySelector(".md-search__input");
            if (input) {
              input.focus();
            }
          }
        }
      });
      searchToggle.addEventListener("change", syncSearch);
      window.addEventListener("pagehide", function () {
        searchToggle.checked = false;
      });
      syncSearch();
    }

    closeDrawer(false);
    syncState();
  });

  /* ------------------------------------------------------------------ *
   * 2 & 3. Current-item state and table-of-contents follow
   *
   * `aria-current` appears nowhere in the theme's markup or bundle, so the
   * current page and the current section are announced as ordinary links. And
   * although the bundle contains a routine that centres the active entry in
   * its pane, it is driven by an observable that stops emitting once the
   * sidebar height settles, so the pane stays at scrollTop 0 while the active
   * entry moves far below the fold.
   * ------------------------------------------------------------------ */
  guard("current-state", function () {
    var secondary = document.querySelector(".md-sidebar--secondary");

    function markNavigation() {
      /* Page-level navigation only: the primary tree also contains a full copy
       * of the in-page contents inside `.md-nav--secondary`, whose links share
       * this document's pathname and must not be marked as the current page. */
      all(".md-nav--primary .md-nav__link[href]").forEach(function (link) {
        if (link.closest(".md-nav--secondary")) {
          return;
        }
        var href = link.getAttribute("href") || "";
        if (href.charAt(0) === "#") {
          return;
        }
        var current =
          link.pathname === window.location.pathname &&
          !!link.closest(".md-nav__item--active");
        if (current) {
          link.setAttribute("aria-current", "page");
        } else if (link.getAttribute("aria-current") === "page") {
          link.removeAttribute("aria-current");
        }
      });
    }

    function markToc() {
      /* Applied to both rendered copies of the contents tree so their state
       * cannot disagree; the copy inside the drawer is inert at overlay widths. */
      all(".md-nav--secondary .md-nav__link[href]").forEach(function (link) {
        if (link.classList.contains("md-nav__link--active")) {
          link.setAttribute("aria-current", "true");
        } else if (link.hasAttribute("aria-current")) {
          link.removeAttribute("aria-current");
        }
      });
      /* Only the copy in the secondary sidebar is the one that scrolls. */
      if (!secondary) {
        return null;
      }
      var actives = all(".md-nav__link--active[href]", secondary);
      return actives.length ? actives[actives.length - 1] : null;
    }

    function follow(active) {
      if (!active || !active.clientHeight) {
        /* Above the first heading the theme marks no entry active at all, so
         * there is nothing to centre. Rewind the pane instead: leaving it
         * wherever the last active entry put it shows the reader a section they
         * have scrolled back above. */
        if (secondary) {
          var idle = secondary.querySelector(".md-sidebar__scrollwrap");
          if (idle && idle.scrollTop !== 0 && (window.scrollY || 0) < 64) {
            idle.scrollTop = 0;
          }
        }
        return;
      }
      var pane = active.closest(".md-sidebar__scrollwrap");
      if (!pane || pane.scrollHeight <= pane.clientHeight + 1) {
        return;
      }
      var linkBox = active.getBoundingClientRect();
      var paneBox = pane.getBoundingClientRect();
      var margin = 24;
      if (
        linkBox.top >= paneBox.top + margin &&
        linkBox.bottom <= paneBox.bottom - margin
      ) {
        return; /* already comfortably in view */
      }
      var delta =
        linkBox.top - paneBox.top - (paneBox.height / 2 - linkBox.height / 2);
      var top = Math.max(
        0,
        Math.min(pane.scrollTop + delta, pane.scrollHeight - pane.clientHeight)
      );
      if (prefersReducedMotion() || typeof pane.scrollTo !== "function") {
        pane.scrollTop = top;
      } else {
        pane.scrollTo({ top: top, behavior: "smooth" });
      }
    }

    var pending = false;
    function update() {
      if (pending) {
        return;
      }
      pending = true;
      window.requestAnimationFrame(function () {
        pending = false;
        markNavigation();
        follow(markToc());
      });
    }

    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update, { passive: true });
    window.addEventListener("hashchange", update);

    /* The theme toggles the active class from its own scroll pipeline, so
     * observing the attribute is what keeps this in step with it. */
    if (secondary && window.MutationObserver) {
      new window.MutationObserver(update).observe(secondary, {
        attributes: true,
        attributeFilter: ["class"],
        subtree: true
      });
    }

    update();
  });

  /* ------------------------------------------------------------------ *
   * 4. Accessible names
   *
   * Every heading permalink is a link whose entire content is "¶", so its
   * accessible name is "¶" — and because the anchor sits inside the heading,
   * that pilcrow is also concatenated into the heading's own name, announcing
   * once per section on top of the link itself. Wrapping the glyph in an
   * aria-hidden span removes it from both computations; an explicit label then
   * names the link after the heading it targets.
   *
   * Separately, every inline icon the theme emits is an unlabelled <svg> that
   * is neither named nor marked decorative.
   * ------------------------------------------------------------------ */
  guard("accessible-names", function () {
    all(".md-typeset a.headerlink").forEach(function (link) {
      var heading = link.closest("h1,h2,h3,h4,h5,h6");
      var name = heading
        ? shortLabel(heading.textContent.replace(/¶/g, ""), 120)
        : "";
      if (!link.querySelector("[aria-hidden]")) {
        var glyph = document.createElement("span");
        glyph.setAttribute("aria-hidden", "true");
        while (link.firstChild) {
          glyph.appendChild(link.firstChild);
        }
        link.appendChild(glyph);
      }
      var label = name ? 'Permalink to "' + name + '"' : "Permalink to this section";
      link.setAttribute("aria-label", label);
      link.setAttribute("title", label);
    });

    all("svg").forEach(function (svg) {
      if (
        svg.hasAttribute("aria-hidden") ||
        svg.hasAttribute("aria-label") ||
        svg.hasAttribute("aria-labelledby") ||
        svg.querySelector("title")
      ) {
        return;
      }
      var labelled = svg.closest("[aria-label],[aria-labelledby],[title]");
      if (labelled || svg.parentElement) {
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
      }
    });
  });

  /* ------------------------------------------------------------------ *
   * 5. Landmarks
   *
   * The theme renders the whole in-page contents tree twice — once inside the
   * navigation drawer and once in the secondary sidebar — so every one of its
   * <nav aria-label="…"> elements exists in duplicate, including two carrying
   * the identical name "Table of contents". At overlay widths the drawer copy
   * is made inert by block 1, which removes it entirely; at wider widths it is
   * present but hidden, so its labels are disambiguated instead.
   * ------------------------------------------------------------------ */
  guard("landmarks", function () {
    var drawerNav = document.querySelector(".md-sidebar--primary .md-nav--primary");
    if (!drawerNav) {
      return;
    }
    all("nav[aria-label]", drawerNav).forEach(function (nav) {
      var label = nav.getAttribute("aria-label");
      if (label && label.indexOf("(navigation drawer)") === -1) {
        nav.setAttribute("aria-label", label + " (navigation drawer)");
      }
    });
  });

  /* ------------------------------------------------------------------ *
   * 6. Scrollable regions, table semantics
   *
   * The theme wraps every wide data table in a `.md-typeset__scrollwrap` and
   * lets the inner <code> of a wide code block scroll, but gives neither a
   * tabindex, a role or a name: content is clipped with no keyboard route to
   * it. Chrome does make an overflowing scroller focusable, which is worse
   * rather than better — it lands in the tab order unnamed, or named by its
   * entire text content.
   *
   * Data tables additionally carry no <caption> and no `scope` on any header
   * cell, and the highlighter's layout tables announce as data tables.
   *
   * The scroll semantics are applied only while an element actually overflows,
   * and re-evaluated when the viewport changes, so nothing lands in the tab
   * order that has nothing hidden. `role="group"` is used rather than
   * `role="region"` deliberately: it exposes the name without adding dozens of
   * landmarks to a page that has real ones.
   * ------------------------------------------------------------------ */
  guard("scroll-regions", function () {
    var article = document.querySelector(".md-content__inner");
    if (!article) {
      return;
    }

    /* Derive a name for a figure, table or code block from whatever introduces
     * it. Only two forms are accepted, so that a name is always a deliberate
     * label rather than the first sentence of whatever prose happened to sit
     * above: a paragraph that opens with a bold "Figure …" or "Table …" run,
     * and otherwise the nearest preceding heading. */
    function nameFor(element, fallback) {
      var node = element;
      while (node && node !== article) {
        var sibling = node.previousElementSibling;
        while (sibling) {
          if (/^H[1-6]$/.test(sibling.tagName)) {
            return shortLabel(sibling.textContent.replace(/¶/g, ""), 90);
          }
          if (sibling.tagName === "P") {
            var strong = sibling.querySelector("strong");
            if (strong && /^(figure|table)\b/i.test(strong.textContent.trim())) {
              return shortLabel(strong.textContent, 90);
            }
          }
          sibling = sibling.previousElementSibling;
        }
        node = node.parentElement;
      }
      return fallback;
    }

    var regions = [];

    /* `resolve` is stored rather than the element itself for data tables. The
     * horizontal scroll wrapper around a wide table is injected by the theme's
     * own asynchronous pipeline, so it does not exist yet when this script
     * runs: resolving it eagerly finds nothing and the table would never be
     * made keyboard-reachable at any viewport width. Resolving it on every
     * evaluation picks it up as soon as the theme creates it.
     *
     * A resolver returning null means "not ready yet, try again". It must NEVER
     * fall back to the `<table>` itself: the theme selects the tables it wraps
     * with `table:not([class])`, so writing any class onto a table before the
     * theme has processed it makes the theme skip that table permanently — it
     * then loses its border, card background, font size and, critically, its
     * `overflow-x: auto`, leaving a focusable element announced as
     * "scrollable horizontally" that cannot scroll at all. */
    function register(resolve, name) {
      regions.push({ resolve: resolve, name: name });
    }

    /* Data tables: caption, header-cell scope, and a named scroll region. */
    all("table:not([class])", article).forEach(function (table) {
      all("thead th", table).forEach(function (th) {
        if (!th.hasAttribute("scope")) {
          th.setAttribute("scope", "col");
        }
      });
      var name = nameFor(table, "Data table");
      if (!table.querySelector("caption")) {
        var caption = document.createElement("caption");
        caption.className = "blitzy-visually-hidden";
        caption.textContent = name;
        table.insertBefore(caption, table.firstChild);
      }
      register(function () {
        return table.closest(".md-typeset__scrollwrap");
      }, name);
    });

    /* The highlighter's line-number layout tables are not data tables. */
    all("table.highlighttable", article).forEach(function (table) {
      table.setAttribute("role", "presentation");
    });

    /* Code blocks: the scroller is the inner <code>. */
    all("pre > code", article).forEach(function (code) {
      var container = code.closest(".highlight, .highlighttable") || code;
      var language = "";
      var match = /(?:^|\s)language-([\w+#-]+)/.exec(container.className || "");
      if (match) {
        language = match[1];
      }
      var name = nameFor(
        code.closest(".highlight") || code.parentElement,
        "Code block"
      );
      register(
        function () {
          return code;
        },
        (language ? language + " code block" : "Code block") +
          (name ? " — " + name : "")
      );
    });

    function evaluate() {
      regions.forEach(function (region) {
        var el = region.resolve();
        if (!el) {
          return;
        }
        /* Clear any semantics left on an element that is no longer the scroller
         * — the theme can move a table into a wrapper after the first pass. */
        if (region.last && region.last !== el) {
          region.last.removeAttribute("tabindex");
          region.last.removeAttribute("role");
          region.last.removeAttribute("aria-label");
          region.last.classList.remove("blitzy-scroll-region");
        }
        region.last = el;
        var overflowing = el.scrollWidth - el.clientWidth > 1;
        if (overflowing) {
          el.setAttribute("tabindex", "0");
          el.setAttribute("role", "group");
          el.setAttribute(
            "aria-label",
            region.name + " — scrollable horizontally"
          );
          el.classList.add("blitzy-scroll-region");
        } else {
          el.removeAttribute("tabindex");
          el.removeAttribute("role");
          el.removeAttribute("aria-label");
          el.classList.remove("blitzy-scroll-region");
        }
      });
    }

    evaluate();

    var pending = false;
    function schedule() {
      if (pending) {
        return;
      }
      pending = true;
      window.requestAnimationFrame(function () {
        pending = false;
        evaluate();
      });
    }

    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("load", schedule);
    if (window.ResizeObserver) {
      var observer = new window.ResizeObserver(schedule);
      observer.observe(article);
    }
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(schedule);
    }
    /* The theme injects the horizontal scroll wrapper around every wide table
     * from its own asynchronous startup pipeline, which completes after this
     * script. Watching the article for that structural change is what lets the
     * table regions be picked up rather than missed. */
    if (window.MutationObserver) {
      new window.MutationObserver(schedule).observe(article, {
        childList: true,
        subtree: true
      });
    }
  });

  /* ------------------------------------------------------------------ *
   * 7. Search dialog hygiene
   *
   * Two defects in the theme's search markup. The container carries
   * `role="dialog"` with no accessible name at all, which axe reports as
   * `aria-dialog-name` on every page. And the result pane keeps
   * `tabindex="0"` while the search is closed, at which point it measures zero
   * pixels high — an invisible tab stop on every page.
   * ------------------------------------------------------------------ */
  guard("search-dialog", function () {
    var dialog = document.querySelector('.md-search[role="dialog"]');
    var toggle = document.getElementById("__search");
    var scrollwrap = document.querySelector(".md-search__scrollwrap");
    var input = document.querySelector(".md-search__input");

    if (dialog && !dialog.getAttribute("aria-label")) {
      var label =
        (input && (input.getAttribute("aria-label") || input.placeholder)) ||
        "Search";
      dialog.setAttribute("aria-label", label);
    }

    if (scrollwrap && toggle) {
      var syncTabStop = function () {
        if (toggle.checked) {
          scrollwrap.setAttribute("tabindex", "0");
        } else {
          scrollwrap.removeAttribute("tabindex");
        }
      };
      toggle.addEventListener("change", syncTabStop);
      syncTabStop();
    }
  });
})();
