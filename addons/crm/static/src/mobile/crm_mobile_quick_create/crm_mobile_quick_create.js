import { Component, onMounted, onPatched, proxy, signal, status } from "@odoo/owl";
import { currencies } from "@web/core/currency";
import { _t } from "@web/core/l10n/translation";
import { user } from "@web/core/user";
import { useViewportChange } from "@web/core/utils/dvu";
import { uniqueId } from "@web/core/utils/functions";
import { formatFloat } from "@web/core/utils/numbers";
import { useCrmFocusKeeper, useCrmOffline, useCrmSheetFocus } from "@crm/mobile/crm_offline_hooks";

/**
 * Values handed to the opener's `onSave`. The keys are `crm.lead` field names and
 * become, unchanged, the `vals` of the `web_save` the opener issues or queues.
 *
 * @typedef {Object} CrmMobileQuickCreateValues
 * @property {string} name trimmed, never empty
 * @property {string|false} contact_name trimmed, false when left empty
 * @property {string|false} phone trimmed, false when left empty
 * @property {string|false} email_from trimmed, false when left empty
 * @property {number} expected_revenue within ±`revenueLimit`, 0 when left empty or
 *  not a number
 * @property {number|false} stage_id id of an offered stage, false when none is offered
 */

function trimmed(value) {
    return String(value ?? "").trim();
}

/**
 * Collects the six-field mobile lead draft and delegates persistence to `onSave`.
 * The opener supplies action context and owns online/offline policy; no onchange
 * is needed. Save requires a nonempty name, an expected revenue within
 * ±`revenueLimit` and an offered stage, closes on resolution and preserves the
 * draft on rejection; `onSave` resolving `false` refuses the stage. Opened only
 * by the small-screen pipeline.
 */
export class CrmMobileQuickCreate extends Component {
    static template = "crm.CrmMobileQuickCreate";
    static props = {
        stages: { type: Array },
        defaultStageId: { type: [Number, Boolean], optional: true },
        onSave: { type: Function },
        close: { type: Function, optional: true },
    };

    /**
     * Name input (`t-ref="this.nameRef"`). It is focused only when Save finds the
     * name empty: autofocus on open would raise the phone keyboard over the sheet's
     * slide-in animation, so the sheet's title takes the focus on open instead.
     */
    nameRef = signal(null);

    /** Expected revenue input (`t-ref="this.revenueRef"`), focused when Save refuses its value. */
    revenueRef = signal(null);

    /** Stage select (`t-ref="this.stageRef"`), focused when Save refuses its value. */
    stageRef = signal(null);

    /**
     * The sheet's root `<form>` (`t-ref="this.rootRef"`, inside the bottom sheet's
     * body) and its title, for its keyboard focus and its scrolling.
     */
    rootRef = signal(null);
    headingRef = signal(null);

    setup() {
        this.crmOffline = useCrmOffline();
        useCrmSheetFocus(this.rootRef, this.headingRef);
        // Save is disabled while it runs, with the title holding the focus inside
        // the sheet: Save takes it back when a failure re-enables it (a success
        // closes the sheet).
        useCrmFocusKeeper(this.rootRef, {
            candidates: () => [this.headingRef()],
            park: () => this.headingRef(),
        });
        // Unique per sheet, so each `<label for>` targets its own control even if
        // two sheets ever coexist.
        this.fieldIdPrefix = uniqueId("o_crm_mobile_quick_create_");
        this.state = proxy({
            name: "",
            contact_name: "",
            phone: "",
            email_from: "",
            expected_revenue: "",
            stage_id: this.props.defaultStageId || this.props.stages[0]?.id || false,
            invalidName: false,
            invalidRevenue: false,
            invalidStage: false,
            isSaving: false,
        });
        // Set once the sheet has asked to close (`closeSheet`).
        this.closed = false;
        /**
         * Ref of the field Save has just flagged invalid: its row, which then gains
         * the field's message, is revealed once that render is patched.
         *
         * @type {Function|null}
         */
        this.rowToReveal = null;
        onMounted(() => {
            // The bottom sheet measures and positions its rail in its own
            // `onMounted`, which runs after this one: expand the sheet once it has.
            Promise.resolve().then(() => {
                if (!this.closed && status(this) === "mounted") {
                    this.expandSheet();
                }
            });
        });
        onPatched(() => {
            const fieldRef = this.rowToReveal;
            this.rowToReveal = null;
            if (fieldRef && !this.closed) {
                this.revealElement(fieldRef()?.closest(".o_crm_mobile_quick_create_row"));
            }
        });
        // The bottom sheet re-measures on a viewport change (phone keyboard,
        // rotation) without moving its rail; this listener runs after its own.
        useViewportChange(() => {
            if (!this.closed && status(this) === "mounted") {
                this.revealElement(this.focusedRow());
            }
        });
    }

    /**
     * Scrolls the bottom sheet's rail to the sheet's own snap point, where the sheet
     * is fully expanded: its bottom edge meets the viewport's, so the sticky
     * Save/Cancel row is in view however tall the form is. The sheet element is the
     * scroll target, so only the rail moves: the body's scroll position is kept.
     * Nothing moves while the sheet slides out.
     */
    expandSheet() {
        this.rootRef()
            ?.closest(".o_bottom_sheet:not(.o_bottom_sheet_dismissing) .o_bottom_sheet_sheet")
            ?.scrollIntoView({ block: "start" });
    }

    /**
     * Expands the sheet, then scrolls `el` into the view of the sheet's body, above
     * the sticky Save/Cancel row (the body's `scroll-padding-block-end`).
     *
     * @param {Element|null|undefined} el
     */
    revealElement(el) {
        this.expandSheet();
        el?.scrollIntoView({ block: "nearest" });
    }

    /** @returns {Element|null} row (label, field, message) of the focused field */
    focusedRow() {
        const root = this.rootRef();
        const row = document.activeElement?.closest(".o_crm_mobile_quick_create_row");
        return root?.contains(row) ? row : null;
    }

    /**
     * A field focused by a tap, Tab or a script is revealed with its label and
     * message; the Save/Cancel buttons are always in view.
     *
     * @param {FocusEvent} ev
     */
    onFocusIn(ev) {
        const row = ev.target.closest(".o_crm_mobile_quick_create_row");
        if (row) {
            this.revealElement(row);
        }
    }

    /**
     * @param {string} name `crm.lead` field name
     * @returns {string} DOM id of that field's control, shared by its `<label for>`
     */
    fieldId(name) {
        return `${this.fieldIdPrefix}_${name}`;
    }

    /**
     * Largest expected revenue, in absolute value, that Save accepts: 10^(14 - d)
     * for a currency of d decimal places (1e12 with cents). A larger amount is no
     * longer stored exactly: the server's currency rounding of a later write shifts
     * its last digits. The new lead's revenue is in its company's currency, and the
     * server picks that company among the enabled ones (`user.activeCompanies`),
     * from the salesperson's sales team first, so d is the most decimal places of
     * their currencies: 2 for a currency the session does not list, and when no
     * company is enabled.
     *
     * @returns {number}
     */
    get revenueLimit() {
        const decimals = user.activeCompanies.map(
            (company) => currencies[company?.currency_id]?.digits?.[1] ?? 2
        );
        return 10 ** (14 - (decimals.length ? Math.max(...decimals) : 2));
    }

    /** Message of a refused expected revenue, naming the accepted range. */
    get revenueFeedback() {
        const limit = this.revenueLimit;
        const format = (value) => formatFloat(value, { digits: [false, 0] });
        return _t("Enter an amount between %(min)s and %(max)s.", {
            min: format(-limit),
            max: format(limit),
        });
    }

    onNameInput() {
        this.state.invalidName = false;
    }

    onRevenueInput() {
        this.state.invalidRevenue = false;
    }

    onStageChange() {
        this.state.invalidStage = false;
    }

    flagInvalidStage() {
        this.flagInvalid("invalidStage", this.stageRef);
    }

    /**
     * Flags a field invalid and focuses it. Its message renders with the next patch,
     * which reveals the field's row; a field already flagged shows its message
     * already, and no render follows, so its row is revealed at once.
     *
     * @param {"invalidName"|"invalidRevenue"|"invalidStage"} flag
     * @param {Function} fieldRef `nameRef`, `revenueRef` or `stageRef`
     */
    flagInvalid(flag, fieldRef) {
        const flagged = this.state[flag];
        this.state[flag] = true;
        fieldRef()?.focus();
        if (flagged) {
            this.revealElement(fieldRef()?.closest(".o_crm_mobile_quick_create_row"));
        } else {
            this.rowToReveal = fieldRef;
        }
    }

    /**
     * Validates the name, the expected revenue (within ±`revenueLimit`) and the
     * stage, in their order in the sheet, flagging and focusing the first invalid
     * one. Then hands the six values to `onSave` and closes the sheet once it
     * resolves, unless with `false` (stage refused). A second Save while one is
     * running is ignored, and so is any Save offline where the queue cannot hold
     * the create (non-secure origin, Save disabled): the draft stays for when the
     * connection returns.
     *
     * @returns {Promise<void>} rejects with `onSave`'s error, sheet left open
     */
    async onSave() {
        if (this.state.isSaving || this.crmOffline.isOfflineQueueBlocked()) {
            return;
        }
        const name = trimmed(this.state.name);
        if (!name) {
            this.flagInvalid("invalidName", this.nameRef);
            return;
        }
        // Empty, or not a number: 0. An amount beyond the limit, an infinite one
        // included, is refused: the server would not store it exactly.
        const expectedRevenue = Number(this.state.expected_revenue) || 0;
        if (!(Math.abs(expectedRevenue) <= this.revenueLimit)) {
            this.flagInvalid("invalidRevenue", this.revenueRef);
            return;
        }
        const { stages } = this.props;
        const stage = stages.find(({ id }) => id === this.state.stage_id);
        if (stages.length && !stage) {
            this.flagInvalidStage();
            return;
        }
        /** @type {CrmMobileQuickCreateValues} */
        const values = {
            name,
            // An empty char field is sent as false, as the form view sends it, so
            // the server stores no value rather than an empty string.
            contact_name: trimmed(this.state.contact_name) || false,
            phone: trimmed(this.state.phone) || false,
            email_from: trimmed(this.state.email_from) || false,
            expected_revenue: expectedRevenue,
            stage_id: stage ? stage.id : false,
        };
        this.state.isSaving = true;
        let accepted;
        try {
            accepted = await this.props.onSave(values);
        } catch (error) {
            if (status(this) !== "destroyed") {
                this.state.isSaving = false;
            }
            throw error;
        }
        if (status(this) === "destroyed") {
            return;
        }
        if (accepted === false) {
            this.state.isSaving = false;
            this.flagInvalidStage();
            return;
        }
        this.closeSheet();
    }

    /**
     * Form submission (Save button, or Enter on the phone keyboard).
     *
     * @param {SubmitEvent} [ev]
     * @returns {Promise<void>}
     */
    onSubmit(ev) {
        ev?.preventDefault();
        return this.onSave();
    }

    onCancel() {
        this.closeSheet();
    }

    /**
     * Closes the sheet once. Each bottom-sheet close also decrements the service's
     * count of open sheets, and the sheet stays on the page until the next render:
     * a repeated Cancel, or a Cancel right after a successful Save, would otherwise
     * close it again and leave later sheets unflagged as open on the page.
     */
    closeSheet() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.props.close?.();
    }
}
