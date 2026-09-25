(() => {
  "use strict";

  const DEFAULT_CATEGORY_ID = "775381b5-df6c-45cb-90eb-4f6a9c8744f3";
  const DEFAULT_CATEGORY_LABEL = "Electronics";
  /** Doc 2.4.3: list data via `QafService.GetItems` on `EAsset_Master`; category/status/search whereClauses are built separately. */
  const MASTER_LIST_OBJECT_NAME = "EAsset_Master";
  const MAX_STATUS_FETCH_PAGE_SIZE = 10000;
  /** Asset list is fetched via `api/rnsp` using this stored-query name; CategoryFilter/TypeFilter/PageNumber/PageSize come from route + pagination state. */
  const ASSET_LIST_RNSP_NAME = "ASSET_TYPE_EASSET_MASTER";
  /** Item-status summary counts (the "Summary" cards) come from this `api/rnsp` stored-query name instead of the legacy `api/Sroa` endpoint. */
  const ITEM_STATUS_RNSP_NAME = "ASSET_TYPE_ITEMSTATUS_FILTER";
  /** Inline cell edits are saved via this `api/rnsp` stored-query instead of `api/UpdateRecord` - Args: RecordID, FieldName, FieldValue. See updateEAssetMasterField(). */
  const EASSET_MASTER_UPDATE_RNSP_NAME = "ASSET_TYPE_EASSET_MASTER_DOUBLETAP_UPDATE";
  /**
   * Inline-edit lookup dropdown options (Type/Category/Vendor/Department/Employee/Team) come
   * from this no-Args `api/rnsp` stored-query, fetched lazily on first double-tap of any of
   * those cells and cached for the rest of the session - see fetchDoubleTapLookupData().
   */
  const DOUBLETAP_DATA_RNSP_NAME = "ASSET_TYPE_DOUBLETAP_DATA";
  /**
   * Maps each asset field's internal (schema) name to the workflow's DataType bucket it should
   * draw its dropdown options from. Several fields share one bucket (e.g. AssignedTo,
   * AssetManager, SupportedBy and ManagedBy all use the same Employee list; AssignedToGroup,
   * SupportedByGroup and ManagedByGroup all use the same Team list) - the workflow is still only
   * ever called once.
   */
  const DOUBLETAP_FIELD_DATATYPE = {
    type: "AssetType",
    category: "Category",
    vendorid: "Vendor",
    department: "Department",
    location: "Location",
    assignedto: "Employee",
    assetmanager: "Employee",
    supportedby: "Employee",
    managedby: "Employee",
    assignedtogroup: "Team",
    supportedbygroup: "Team",
    managedbygroup: "Team"
  };

  function getAppApiBase() {
    try {
      const raw = window.localStorage.getItem("env");
      const trimmed = String(raw || "").trim();
      if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, "");
      const parsed = tryParseJson(trimmed);
      if (typeof parsed === "string" && /^https?:\/\//i.test(parsed)) return parsed.replace(/\/+$/, "");
      if (parsed && typeof parsed === "object") {
        const u = parsed.baseUrl || parsed.BaseUrl || parsed.apiUrl || parsed.URL || parsed.url || "";
        if (typeof u === "string" && /^https?:\/\//i.test(u)) return u.replace(/\/+$/, "");
      }
    } catch (_e) {
      /* ignore */
    }
    return String((window.location && window.location.origin) || "").replace(/\/+$/, "");
  }

  /** Same service as `bundle.js` (QafService.GetItems); used for asset list/search so headers match the portal. */
  function getQafService() {
    try {
      if (window.QafService && typeof window.QafService.GetItems === "function") {
        return window.QafService;
      }
      if (
        window.parent &&
        window.parent !== window &&
        window.parent.QafService &&
        typeof window.parent.QafService.GetItems === "function"
      ) {
        return window.parent.QafService;
      }
    } catch (_e) {
      /* cross-origin parent */
    }
    return null;
  }

  function getQafPageService() {
    return findHostQafPageService();
  }

  function findHostQafPageService() {
    const hasPageService = (svc) =>
      svc &&
      (typeof svc.AddItem === "function" ||
        typeof svc.ViewItem === "function" ||
        typeof svc.EditItem === "function" ||
        typeof svc.DeleteItem === "function");
    try {
      if (hasPageService(window.QafPageService)) return window.QafPageService;
      if (window.parent && window.parent !== window && hasPageService(window.parent.QafPageService)) {
        return window.parent.QafPageService;
      }
      if (window.top && window.top !== window && hasPageService(window.top.QafPageService)) {
        return window.top.QafPageService;
      }
    } catch (_e) {
      /* cross-origin parent/top */
    }
    return null;
  }

  function resolveImportBulkDataService() {
    const services = [];
    const pushUnique = (svc) => {
      if (!svc || services.indexOf(svc) !== -1) return;
      services.push(svc);
    };
    try {
      pushUnique(window.parent && window.parent !== window ? window.parent.QafPageService : null);
    } catch (_e) {
      /* cross-origin parent */
    }
    try {
      pushUnique(window.top && window.top.QafPageService);
    } catch (_e) {
      /* cross-origin top */
    }
    pushUnique(window.QafPageService);

    for (let i = 0; i < services.length; i += 1) {
      const svc = services[i];
      if (typeof svc.ImportBulkData === "function") {
        return svc;
      }
    }
    for (let i = 0; i < services.length; i += 1) {
      const svc = services[i];
      if (typeof svc.openImportBulkData === "function") {
        return svc;
      }
    }
    return null;
  }

  function waitForImportBulkDataService(maxWaitMs) {
    const limit = Number.isFinite(maxWaitMs) ? maxWaitMs : 5000;
    const immediate = resolveImportBulkDataService();
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve, reject) => {
      let tries = 0;
      const maxTries = Math.max(1, Math.ceil(limit / 100));
      const timer = window.setInterval(() => {
        tries += 1;
        const service = resolveImportBulkDataService();
        if (service) {
          window.clearInterval(timer);
          resolve(service);
          return;
        }
        if (tries >= maxTries) {
          window.clearInterval(timer);
          reject(new Error("QafPageService.ImportBulkData is not available."));
        }
      }, 100);
    });
  }

  function invokeImportBulkDataOnService(service, objectName, callback, hiddenFieldsWithValue, hiddenFields) {
    if (typeof service.ImportBulkData === "function") {
      service.ImportBulkData(
        objectName,
        callback,
        hiddenFieldsWithValue,
        hiddenFields
      );
      return;
    }
    if (typeof service.openImportBulkData === "function") {
      service.openImportBulkData(
        {
          objectName: objectName,
          repository: objectName,
          callback: callback,
          hiddenFieldsWithValue: hiddenFieldsWithValue,
          hiddenFields: hiddenFields
        },
        callback
      );
      return;
    }
    throw new Error("QafPageService.ImportBulkData is not available.");
  }

  function syncBundleEnvUrl() {
    const base = getAppApiBase();
    if (!base) return "";
    try {
      window.localStorage.setItem("env", base);
      const service = getQafService();
      if (service && typeof service.SetEnvUrl === "function") service.SetEnvUrl(base);
    } catch (_e) {
      /* ignore */
    }
    return base;
  }

  function promiseWithAbort(signal, promise) {
    if (!signal) return promise;
    if (signal.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        const err = new Error("Aborted");
        err.name = "AbortError";
        reject(err);
      };
      signal.addEventListener("abort", onAbort);
      Promise.resolve(promise).then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (reason) => {
          signal.removeEventListener("abort", onAbort);
          reject(reason);
        }
      );
    });
  }

  const PAGE_SIZE = 20;
  const PRELOAD_CLASS = "asset-details-preload";
  const PAGE_ACCESS_NEW_LP = ["11", "22-3", "22-1", "22-2"];
  const FULL_ACCESS_NEW_LP = ["11", "22-3"];
  const REFRESH_ON_RETURN_KEY = "asset-details-refresh-on-return";
  const SELECTED_ASSET_STORAGE_KEY = "asset-selected-for-serial-summary";
  const SERIAL_DETAILS_PAGE_PATH = "/pages/AssetDetails";
  const ASSET_OBJECT_ID = "5bf876e9-6038-4536-bf37-e39b74a171c3";
  const ROW_ACTIONS_COLUMN_WIDTH = 28;
  const MIN_COLUMN_WIDTH = 100;
  const MAX_COLUMN_WIDTH = 420;
  /** GridTable persists this grid's dragged column widths under this key. */
  const COLUMN_RESIZE_STORAGE_KEY = "asset-type-grid";

  const MERGE_KEY_FIELDS = ["RecordID", "objectid", "ID"];
  /** Per-row identity for dedupe/render keys â€” never use objectid (shared repository id). */
  const RECORD_KEY_FIELDS = ["RecordID", "RecordId", "recordID", "recordid", "ID", "Id"];
  /** Always request these for list calls so client category/type filters and status filtering stay correct. */
  const LIST_ANCHOR_FIELDS = ["Category", "Type", "ItemStatus"];
  const assetQueryPathCache = new Map();
  const STATUS_ORDER = [
    "Allocated",
    "In Store",
    "In Repair",
    "Other",
    "In Repair-Vendor",
    "Send for Disposal",
    "Disposed",
    "GrossTotal"
  ];
  const STATUS_ORDER_CANONICAL_MAP = STATUS_ORDER.reduce((acc, status) => {
    acc[normalizeStatusToken(status)] = status;
    return acc;
  }, {});
  const SYSTEM_NON_EDITABLE_KEYS = new Set([
    "SerialNumber",
    "SerialNo.",
    "Created By",
    "Modified By",
    "Created Date",
    "Modified Date",
    "RecordID",
    "ID"
  ]);
  const COLUMN_KEY_TO_INTERNAL_NAME = {
    Make: "Manufacturer",
    PurchaseAmount: "Price",
    AssetManager: "Asset Manager",
    "Asset Manager": "AssetManager",
    "Created By": "CreatedBy",
    "Modified By": "LastModifiedBy",
    "Created Date": "CreatedDate",
    "Modified Date": "LastModifiedDate"
  };

  function isAssetDetailsRuntimeContext() {
    const pathname = String((window.location && window.location.pathname) || "").toLowerCase();
    if (!pathname) return false;
    return (
      pathname.includes("/pages/assettype") ||
      pathname.includes("/asset-details") ||
      pathname.endsWith("/asset-details.html")
    );
  }

  function ensureAppMarkup() {
    if (!isAssetDetailsRuntimeContext()) return false;
    const existingTables = document.querySelectorAll("#assetTable");
    if (existingTables.length > 1) {
      const generatedHosts = document.querySelectorAll("#assetDetailsAppHost");
      for (let i = 1; i < generatedHosts.length; i += 1) {
        generatedHosts[i].remove();
      }
      if (generatedHosts.length && existingTables.length > 1) {
        generatedHosts[0].remove();
      }
    }
    if (document.getElementById("assetTable")) return true;
    // Avoid mounting before parser completes, which can create duplicate layouts.
    if (document.readyState === "loading") return false;
    if (!document.body) return false;
    const mountTarget = document.querySelector("app-root") || document.body;
    const host = document.createElement("div");
    host.id = "assetDetailsAppHost";
    host.innerHTML = `
      <nav class="qaf-navdock" aria-label="Application menu">
        <button id="qafNavToggle" type="button" class="qaf-navdock__arrow-indicator" aria-label="Pin or expand sidebar" aria-expanded="false">
          <i class="fa fa-angle-right" aria-hidden="true"></i>
        </button>
        <div id="qafNavdockList" class="qaf-navdock__list"></div>
      </nav>
      <main class="asset-details-page qaf-navdock-layout-shift" aria-busy="true">
        <header class="page-header">
          <h1 id="pageTitle">Asset Details</h1>
        </header>
        <section class="summary-section" aria-labelledby="summaryHeading">
          <div id="statusCards" class="status-cards" role="group" aria-label="Asset item status"></div>
        </section>
        <section class="panel table-panel">
          <div class="table-panel__toolbar">
            <!-- Search bar: .qaf-search* comes from global.css. adetail-search-wrap is a
                 behavior hook only (syncAssetSearchClearBtn), it carries no styling. -->
            <div class="qaf-search adetail-search-wrap" role="search">
              <button id="assetSearchSubmit" class="adetail-search__submit" type="button" aria-label="Search">
                <i class="fa fa-search qaf-search__icon" aria-hidden="true"></i>
              </button>
              <input
                id="assetSearchInput"
                class="qaf-search__field"
                type="search"
                placeholder="Search..."
                autocomplete="off"
              />
              <button
                id="assetSearchClear"
                class="qaf-search__clear"
                type="button"
                aria-label="Clear search"
                hidden
              >
                &times;
              </button>
            </div>
            <div class="table-panel__actions">
              <button id="newAssetBtn" type="button" class="qaf-btn qaf-cs-theme-btn qaf-cs-theme-btn--primary">+ New</button>
              <div class="more-menu-wrap">
                <button id="moreBtn" type="button" class="qaf-btn qaf-cs-theme-btn qaf-cs-theme-btn--primary" aria-expanded="false">More</button>
                <div id="moreMenu" class="more-menu" hidden>
                  <button id="moreImportBtn" type="button">Import</button>
                  <button id="moreExportBtn" type="button">Export</button>
                </div>
              </div>
            </div>
          </div>
          <div class="table-panel__top">
            <div id="resultMeta" class="table-panel__meta" hidden>
              <strong id="resultCount">0</strong>
              <span id="resultScope">records</span>
            </div>
          </div>
          <div id="tableWrap" class="table-wrap table-wrap--scrollable">
            <table id="assetTable" aria-label="Assets list">
              <colgroup id="tableColGroup"></colgroup>
              <thead>
                <tr id="tableHeadRow"></tr>
              </thead>
              <tbody id="tableBody"></tbody>
            </table>
            <div id="loadMoreSentinel" class="load-more-sentinel" aria-hidden="true"></div>
          </div>
          <div class="table-panel__footer">
            <span id="loadMoreHint" class="load-more-hint" hidden></span>
          </div>
        </section>
        <section id="errorBox" class="panel error" hidden></section>
      </main>
    `;
    mountTarget.appendChild(host);
    return true;
  }

  let lastPortalTopbarPx = -1;
  let portalResizeSyncTimer = null;

  function syncPortalLayoutOffsets() {
    const docEl = document.documentElement;
    if (!docEl) return;
    const candidates = [
      "header",
      ".topbar",
      ".app-header",
      ".navbar",
      ".mat-toolbar",
      ".qaf-topbar"
    ];
    let topOffset = 0;
    for (let i = 0; i < candidates.length; i += 1) {
      const el = document.querySelector(candidates[i]);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect && rect.height > 0 && rect.height < 220) {
        topOffset = Math.max(topOffset, Math.round(rect.height));
      }
    }

    // Fallback for host shells where header uses custom wrappers/classes.
    const topCandidates = document.querySelectorAll("body *");
    for (let i = 0; i < topCandidates.length; i += 1) {
      const el = topCandidates[i];
      const style = window.getComputedStyle(el);
      const position = style.position;
      if (position !== "fixed" && position !== "sticky") continue;
      const rect = el.getBoundingClientRect();
      if (!rect || rect.height <= 0 || rect.height >= 220) continue;
      if (rect.top > 2) continue;
      if (rect.width < window.innerWidth * 0.45) continue;
      topOffset = Math.max(topOffset, Math.round(rect.height));
    }
    const resolvedTopOffset = topOffset > 0 ? topOffset : 64;
    if (lastPortalTopbarPx === resolvedTopOffset) return;
    lastPortalTopbarPx = resolvedTopOffset;
    docEl.style.setProperty("--portal-topbar-offset", `${resolvedTopOffset}px`);
  }

  function scheduleSyncPortalLayoutOffsets() {
    if (portalResizeSyncTimer) window.clearTimeout(portalResizeSyncTimer);
    portalResizeSyncTimer = window.setTimeout(() => {
      portalResizeSyncTimer = null;
      syncPortalLayoutOffsets();
    }, 120);
  }

  function refreshUiRefs() {
    ui.main = document.querySelector("#assetDetailsAppHost .asset-details-page");
    ui.pageTitle = document.getElementById("pageTitle");
    ui.statusCards = document.getElementById("statusCards");
    ui.tableWrap = document.getElementById("tableWrap");
    ui.tableElement = document.getElementById("assetTable");
    ui.tableColGroup = document.getElementById("tableColGroup");
    ui.tableHeadRow = document.getElementById("tableHeadRow");
    ui.tableBody = document.getElementById("tableBody");
    ui.loadMoreSentinel = document.getElementById("loadMoreSentinel");
    ui.resultMeta = document.getElementById("resultMeta");
    ui.resultCount = document.getElementById("resultCount");
    ui.resultScope = document.getElementById("resultScope");
    ui.loadMoreHint = document.getElementById("loadMoreHint");
    ui.newAssetBtn = document.getElementById("newAssetBtn");
    ui.moreBtn = document.getElementById("moreBtn");
    ui.moreMenu = document.getElementById("moreMenu");
    ui.moreImportBtn = document.getElementById("moreImportBtn");
    ui.moreExportBtn = document.getElementById("moreExportBtn");
    ui.assetSearchInput = document.getElementById("assetSearchInput");
    ui.assetSearchSubmit = document.getElementById("assetSearchSubmit");
    ui.assetSearchClear = document.getElementById("assetSearchClear");
    ui.errorBox = document.getElementById("errorBox");
  }

  const state = {
    allRows: [],
    apiRows: [],
    localRows: [],
    filteredRows: [],
    statusSummary: [],
    selectedStatus: "",
    searchQuery: "",
    hasLoadedOnce: false,
    requestVersion: 0,
    listRequestId: 0,
    nextApiPage: 1,
    assetsLoading: false,
    assetsHasMore: true,
    seenRecordKeys: new Set(),
    columnWidths: [],
    employeesMap: {},
    recordIdToEmployeeGuid: {},
    categoryId: DEFAULT_CATEGORY_ID,
    categoryLabel: DEFAULT_CATEGORY_LABEL,
    typeId: "",
    typeLabel: "",
    routeAssetCount: null,
    routeHasZeroAssets: false,
    newAssetViewId: "",
    assetViewRows: null,
    assetViewRowsPromise: null,
    assetViewFields: [],
    objectFieldMetaById: null,
    objectFieldMetaByInternalName: null,
    objectFieldMetaByDisplayName: null,
    columnDefs: [],
    masterObjectId: "",
    masterObjectRow: null,
    rawRowsByRecordKey: {},
    activeEditCell: null,
    activeRowMenuRecordKey: null,
    repositoryContextCache: {},
    sessionAbort: null,
    sortState: {
      columnKey: null,
      columnIndex: null,
      direction: null
    }
  };

  /** Internal/system fields that must never render as a visible asset-list column. */
  const HIDDEN_SYSTEM_COLUMN_KEYS = new Set([
    "id",
    "objectid",
    "recordid",
    "parentrecordid",
    "createdbyguid",
    "createddate",
    "lastmodifieddate"
  ]);

  function isHiddenSystemColumn(column) {
    if (!column) return false;
    const candidates = [column.key, column.internalName, column.displayName];
    return candidates.some(
      (name) => name && HIDDEN_SYSTEM_COLUMN_KEYS.has(normalizeLooseFieldName(name))
    );
  }

  function getActiveColumnDefs() {
    const defs = Array.isArray(state.columnDefs) ? state.columnDefs : [];
    return defs.filter((column) => !isHiddenSystemColumn(column));
  }

  function getActiveFieldList() {
    const out = [];
    const seen = new Set();
    const add = (name) => {
      const value = String(name || "").trim();
      if (!value || seen.has(value)) return;
      seen.add(value);
      out.push(value);
    };

    getViewFieldsFetchFieldList().forEach(add);

    getActiveColumnDefs().forEach((column) => {
      add(column && column.key);
      add(column && column.internalName);
      add(column && column.viewDsNm);
      add(getInternalNameForColumnKey(column && column.key));
    });
    return out;
  }

  let gridTable = null;
  let lazyLoadScrollBound = false;
  // Handles handed back by library.js: the sized 480px scroller and the
  // near-bottom watcher that pages the next records in.
  let scrollableTable = null;
  let lazyLoadScrollHandler = null;
  let eventsBound = false;
  let rowMenuScrollDismissBound = false;
  let pageInitialized = false;
  let activeRouteSignature = "";
  let releasePreloadAfterLoad = false;
  let lastLoadTriggeredAt = 0;
  /** Used to ignore spurious "route changed" / cross-tab refresh flags while the URL is unchanged. */
  let lastCompletedDataLoadLocation = "";
  let masterObjectFetchPromise = null;

  const ui = {
    main: null,
    pageTitle: null,
    statusCards: null,
    tableWrap: null,
    tableElement: null,
    tableColGroup: null,
    tableHeadRow: null,
    tableBody: null,
    loadMoreSentinel: null,
    resultMeta: null,
    resultCount: null,
    resultScope: null,
    loadMoreHint: null,
    newAssetBtn: null,
    moreBtn: null,
    moreMenu: null,
    moreImportBtn: null,
    moreExportBtn: null,
    assetSearchInput: null,
    assetSearchSubmit: null,
    assetSearchClear: null,
    errorBox: null
  };

  // Hide UI briefly until initialization finishes to avoid first-frame glitches.
  document.documentElement.classList.add(PRELOAD_CLASS);

  const MASTER_EDIT_FORM = {
    formName: "EAsset Master",
    repository: MASTER_LIST_OBJECT_NAME,
    objectId: "deea3ada-225e-44de-a785-2d81a45e9851",
    viewId: ""
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function parseLookupLabel(value) {
    if (value == null) return "";
    const text = String(value);
    const split = text.split(";#");
    return split.length > 1 ? split[1] : text;
  }

  function parseLookupId(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    return text.split(";#")[0].trim();
  }

  const GUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function isGuid(value) {
    return GUID_RE.test(String(value || "").trim());
  }

  function normalizeCategoryToken(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function refreshOnReturnStorageKey() {
    try {
      if (window.self === window.top) {
        const PREFIX = "__qaf_asset_d__:";
        if (!window.name || !String(window.name).startsWith(PREFIX)) {
          window.name = `${PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 11)}`;
        }
        return `${REFRESH_ON_RETURN_KEY}:${window.name}`;
      }
    } catch (_e) {
      // Cross-origin top reference; fall back to global key.
    }
    return REFRESH_ON_RETURN_KEY;
  }

  function markRefreshOnReturn() {
    try {
      sessionStorage.setItem(refreshOnReturnStorageKey(), "1");
    } catch (_error) {
      // Ignore storage limitations.
    }
  }

  function consumeRefreshOnReturnFlag() {
    try {
      const key = refreshOnReturnStorageKey();
      const value = sessionStorage.getItem(key);
      if (value === "1") {
        sessionStorage.removeItem(key);
        return true;
      }
    } catch (_error) {
      // Ignore storage limitations.
    }
    return false;
  }

  function clearRefreshOnReturnFlag() {
    try {
      sessionStorage.removeItem(refreshOnReturnStorageKey());
    } catch (_error) {
      // Ignore storage limitations.
    }
  }

  /*
   * Serial-number links stay relative: no base URL is prefixed, so the link
   * always resolves against whatever origin the page is already being served
   * from. (This used to read a host out of localStorage["ma"] and prefix its
   * origin, which pinned the link to that host.)
   */
  function buildSerialDetailsPageUrl(row) {
    const params = new URLSearchParams();
    const recordId = String((row && (row.__recordID || row.RecordID || row.ID)) || "").trim();
    if (recordId) params.set("recordId", recordId);
    const query = params.toString();
    return query ? `${SERIAL_DETAILS_PAGE_PATH}?${query}` : SERIAL_DETAILS_PAGE_PATH;
  }

  function persistSelectedAssetForSummary(row) {
    try {
      if (!row || typeof row !== "object") return;
      sessionStorage.setItem(SELECTED_ASSET_STORAGE_KEY, JSON.stringify(row));
    } catch (_error) {
      // Ignore storage limitations.
    }
  }

  function openSerialDetailsPage(recordKey) {
    const row = state.filteredRows.find((item) => item && item.__recordKey === recordKey);
    if (!row) {
      handleRowAction("view", recordKey);
      return;
    }
    persistSelectedAssetForSummary(row);
    const destination = buildSerialDetailsPageUrl(row);
    window.location.assign(destination);
  }

  function getRecordFieldValueByInternalNames(sourceRow, internalNames) {
    const values = sourceRow && sourceRow.RecordFieldValues;
    if (!Array.isArray(values) || !values.length) return "";
    const normalizedTargets = new Set(
      (Array.isArray(internalNames) ? internalNames : [])
        .map((item) => String(item || "").trim().toLowerCase())
        .filter(Boolean)
    );
    if (!normalizedTargets.size) return "";
    for (let i = 0; i < values.length; i += 1) {
      const item = values[i] || {};
      const name = String(item.FieldInternalName || "").trim().toLowerCase();
      if (!name || !normalizedTargets.has(name)) continue;
      const raw = item.UGFieldValue ?? item.UGFfieldValue ?? item.FieldValue ?? "";
      if (raw == null) continue;
      const text = String(raw).trim();
      if (text) return text;
    }
    return "";
  }

  /** Merge RecordFieldValues onto the row so top-level keys match category/type filters and MERGE_KEY_FIELDS. */
  function mergeRecordFieldValuesIntoRow(row) {
    if (!row || typeof row !== "object") return row;
    const rfv = Array.isArray(row.RecordFieldValues) ? row.RecordFieldValues : [];
    if (!rfv.length) return row;
    const out = { ...row };
    for (let i = 0; i < rfv.length; i += 1) {
      const entry = rfv[i] || {};
      const internal = String(
        entry.FieldInternalName || entry.InternalName || entry.FieldName || entry.Name || ""
      ).trim();
      if (!internal) continue;
      const raw = entry.UGFieldValue ?? entry.UGFfieldValue ?? entry.FieldValue ?? "";
      if (raw == null) continue;
      const text = String(raw).trim();
      if (!text) continue;
      const current = out[internal];
      if (current == null || String(current).trim() === "") {
        out[internal] = raw;
      }
    }
    return out;
  }

  function parseAssignedRecordIds(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value
        .map((entry) => entry && (entry.RecordID || entry.recordID))
        .filter(Boolean);
    }
    const text = String(value).trim();
    const parsedOuter = tryParseJson(text);
    if (typeof parsedOuter === "string") {
      return parseAssignedRecordIds(parsedOuter);
    }
    if (Array.isArray(parsedOuter)) {
      return parsedOuter
        .map((entry) => {
          if (!entry || typeof entry !== "object") return "";
          return entry.RecordID || entry.recordID || "";
        })
        .filter(Boolean);
    }
    if (parsedOuter && typeof parsedOuter === "object" && (parsedOuter.RecordID || parsedOuter.recordID)) {
      return [parsedOuter.RecordID || parsedOuter.recordID].filter(Boolean);
    }
    if (!text.startsWith("[") || !text.endsWith("]")) return [];
    const parsed = tryParseJson(text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => entry && (entry.RecordID || entry.recordID))
      .filter(Boolean);
  }

  /* ------------------------------------------------------------------ *
   * Date/time display is driven entirely by the user's LocalStorage
   * settings - no timezone is hardcoded anywhere in this file.
   *   CS_SETTING -> TimeZone : "GUID;#(UTC+5:30) Chennai, Kolkata, ..."
   *   TimeFormat             : "12 Hour" | "24 Hour"
   * Every DateTime coming back from the API is UTC and is shifted by the
   * offset parsed out of CS_SETTING before it is rendered.
   * ------------------------------------------------------------------ */

  /** This page renders dates only (no clock time) in the grid/search. */
  const DISPLAY_DATE_ONLY = true;

  /** Matches "(UTC+5:30)", "(UTC-04:00)", "(UTC)", "(GMT+10:30)". */
  const UTC_OFFSET_PATTERN = /\(\s*(?:UTC|GMT)\s*(?:([+-])\s*(\d{1,2})(?:\s*:\s*(\d{1,2}))?)?\s*\)/i;

  let userTimeSettingsCache = null;

  function readLocalStorageText(key) {
    try {
      const raw = window.localStorage ? window.localStorage.getItem(key) : null;
      let text = String(raw == null ? "" : raw).trim();
      if (text.length > 1 && text.charAt(0) === '"' && text.charAt(text.length - 1) === '"') {
        const unquoted = tryParseJson(text);
        if (typeof unquoted === "string") text = unquoted.trim();
      }
      return text;
    } catch (_e) {
      return "";
    }
  }

  /** Pulls the raw `GUID;#(UTC+5:30) City, City` TimeZone value out of CS_SETTING. */
  function extractCsSettingTimeZoneValue(csRaw) {
    const raw = String(csRaw || "").trim();
    if (!raw) return "";
    const candidates = [];
    let parsed = tryParseJson(raw);
    if (typeof parsed === "string") parsed = tryParseJson(parsed);
    if (parsed && typeof parsed === "object") {
      candidates.push(parsed);
      if (typeof parsed.value === "string") {
        const inner = tryParseJson(parsed.value);
        if (inner && typeof inner === "object") candidates.push(inner);
      } else if (parsed.value && typeof parsed.value === "object") {
        candidates.push(parsed.value);
      }
    }
    for (let i = 0; i < candidates.length; i += 1) {
      const entry = candidates[i];
      const value = entry.TimeZone || entry.Timezone || entry.timeZone || entry.timezone;
      if (value) return String(value);
    }
    // CS_SETTING may not be valid JSON - scan the raw text for the offset.
    return raw;
  }

  /** "(UTC+5:30)" -> 330, "(UTC-04:00)" -> -240, "(UTC)" -> 0, unknown -> null. */
  function extractUtcOffsetMinutes(timeZoneValue) {
    const match = UTC_OFFSET_PATTERN.exec(String(timeZoneValue || ""));
    if (!match) return null;
    if (!match[1]) return 0;
    const hours = Number(match[2] || 0);
    const minutes = Number(match[3] || 0);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    const total = hours * 60 + minutes;
    return match[1] === "-" ? -total : total;
  }

  /** Re-parses only when the stored settings actually change. */
  function getUserTimeSettings() {
    const csRaw = readLocalStorageText("CS_SETTING");
    const formatRaw = readLocalStorageText("TimeFormat");
    if (
      userTimeSettingsCache &&
      userTimeSettingsCache.csRaw === csRaw &&
      userTimeSettingsCache.formatRaw === formatRaw
    ) {
      return userTimeSettingsCache;
    }
    const offsetMinutes = extractUtcOffsetMinutes(extractCsSettingTimeZoneValue(csRaw));
    userTimeSettingsCache = {
      csRaw,
      formatRaw,
      offsetMinutes: Number.isFinite(offsetMinutes) ? offsetMinutes : 0,
      is12Hour: !/24/.test(formatRaw)
    };
    return userTimeSettingsCache;
  }

  function tryParseDateValue(input) {
    if (input == null || input === "") return null;
    if (input instanceof Date) {
      return Number.isNaN(input.getTime()) ? null : input;
    }
    if (typeof input === "number" && Number.isFinite(input)) {
      const d = new Date(input);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    let text = String(input).trim();
    if (!text) return null;

    const net = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(text);
    if (net) {
      const d = new Date(Number(net[1]));
      return Number.isNaN(d.getTime()) ? null : d;
    }

    // Already-rendered display value: DD/MM/YYYY [hh:mm[:ss] [AM/PM]] (day first).
    const displayFmt =
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\s*([AaPp])\.?[Mm]\.?)?)?$/.exec(
        text
      );
    if (displayFmt) {
      const day = Number(displayFmt[1]);
      const month = Number(displayFmt[2]) - 1;
      const year = Number(displayFmt[3]);
      let hours = displayFmt[4] != null ? Number(displayFmt[4]) : 0;
      const minutes = displayFmt[5] != null ? Number(displayFmt[5]) : 0;
      const seconds = displayFmt[6] != null ? Number(displayFmt[6]) : 0;
      const meridiem = displayFmt[7] ? displayFmt[7].toLowerCase() : "";
      if (meridiem === "p" && hours < 12) hours += 12;
      if (meridiem === "a" && hours === 12) hours = 0;
      if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
        const d = new Date(Date.UTC(year, month, day, hours, minutes, seconds));
        return Number.isNaN(d.getTime()) ? null : d;
      }
    }

    const ms = Date.parse(text);
    if (!Number.isNaN(ms)) return new Date(ms);
    return null;
  }

  /**
   * Parses a UTC DateTime exactly as the API returns it:
   *   - `MM/DD/YYYY hh:mm:ss AM/PM`  (e.g. 7/28/2026 5:14:39 AM)
   *   - `YYYY-MM-DDTHH:mm:ss`        (e.g. 2026-07-28T05:24:37)
   * Both are treated as UTC. Values that already carry an explicit zone
   * (trailing `Z` or `+05:30`) are honoured as-is.
   */
  function tryParseUtcDateValue(input) {
    if (input == null || input === "") return null;
    if (input instanceof Date) {
      return Number.isNaN(input.getTime()) ? null : input;
    }
    if (typeof input === "number" && Number.isFinite(input)) {
      const d = new Date(input);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const text = String(input).trim();
    if (!text) return null;

    const net = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(text);
    if (net) {
      const d = new Date(Number(net[1]));
      return Number.isNaN(d.getTime()) ? null : d;
    }

    // Format 1: MM/DD/YYYY [hh:mm[:ss] [AM/PM]] - month first, UTC.
    const usFormat =
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[\sT]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.\d+)?(?:\s*([AaPp])\.?[Mm]\.?)?)?$/.exec(
        text
      );
    if (usFormat) {
      const month = Number(usFormat[1]) - 1;
      const day = Number(usFormat[2]);
      const year = Number(usFormat[3]);
      let hours = usFormat[4] != null ? Number(usFormat[4]) : 0;
      const minutes = usFormat[5] != null ? Number(usFormat[5]) : 0;
      const seconds = usFormat[6] != null ? Number(usFormat[6]) : 0;
      const meridiem = usFormat[7] ? usFormat[7].toLowerCase() : "";
      if (meridiem === "p" && hours < 12) hours += 12;
      if (meridiem === "a" && hours === 12) hours = 0;
      if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
        const utcDate = new Date(Date.UTC(year, month, day, hours, minutes, seconds));
        return Number.isNaN(utcDate.getTime()) ? null : utcDate;
      }
    }

    // Format 2: YYYY-MM-DD[THH:mm[:ss]] with no zone suffix - UTC.
    const isoFormat =
      /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.\d+)?)?$/.exec(text);
    if (isoFormat) {
      const utcDate = new Date(
        Date.UTC(
          Number(isoFormat[1]),
          Number(isoFormat[2]) - 1,
          Number(isoFormat[3]),
          isoFormat[4] != null ? Number(isoFormat[4]) : 0,
          isoFormat[5] != null ? Number(isoFormat[5]) : 0,
          isoFormat[6] != null ? Number(isoFormat[6]) : 0
        )
      );
      return Number.isNaN(utcDate.getTime()) ? null : utcDate;
    }

    // Explicit zone already present - absolute instant.
    if (/(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(text)) {
      const ms = Date.parse(text);
      if (!Number.isNaN(ms)) return new Date(ms);
    }

    return tryParseDateValue(text);
  }

  /**
   * Shifts a UTC instant into the user's configured zone. The returned Date
   * carries the target wall-clock time in its UTC getters, so read it with
   * getUTC* only.
   */
  function toUserZonedDate(input) {
    const utcDate = tryParseUtcDateValue(input);
    if (!utcDate) return null;
    // A bare date carries no instant, so shifting it would roll the day on
    // negative offsets. Only true DateTime values get the offset applied.
    if (!hasTimeComponent(input)) return utcDate;
    return new Date(utcDate.getTime() + getUserTimeSettings().offsetMinutes * 60000);
  }

  /** False for `7/28/2026` and `2026-07-28`, true once a clock time is present. */
  function hasTimeComponent(input) {
    if (input instanceof Date || typeof input === "number") return true;
    const text = String(input == null ? "" : input).trim();
    if (!text) return false;
    return /\d{1,2}:\d{2}/.test(text) || /^\/Date\(/.test(text);
  }

  function formatZonedDatePart(zoned) {
    const dd = String(zoned.getUTCDate()).padStart(2, "0");
    const mm = String(zoned.getUTCMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}/${zoned.getUTCFullYear()}`;
  }

  /** DD/MM/YYYY in the user's timezone. */
  function formatUserDate(input) {
    const zoned = toUserZonedDate(input);
    return zoned ? formatZonedDatePart(zoned) : "";
  }

  /** DD/MM/YYYY hh:mm:ss AM/PM (12 Hour) or DD/MM/YYYY HH:mm:ss (24 Hour). */
  function formatUserDateTime(input, includeSeconds = true) {
    const zoned = toUserZonedDate(input);
    if (!zoned) return "";
    const settings = getUserTimeSettings();
    let hours = zoned.getUTCHours();
    let suffix = "";
    if (settings.is12Hour) {
      suffix = hours >= 12 ? " PM" : " AM";
      hours = hours % 12;
      if (hours === 0) hours = 12;
    }
    const hh = String(hours).padStart(2, "0");
    const min = String(zoned.getUTCMinutes()).padStart(2, "0");
    const time = includeSeconds
      ? `${hh}:${min}:${String(zoned.getUTCSeconds()).padStart(2, "0")}`
      : `${hh}:${min}`;
    return `${formatZonedDatePart(zoned)} ${time}${suffix}`;
  }

  function isFieldDateOnly(meta) {
    return Boolean(meta && meta.dateOnly === true);
  }

  function isDateTimeFieldMeta(meta) {
    if (!meta) return false;
    return String(meta.dataType || "").toUpperCase() === "DTM";
  }

  function formatTableDateValue(raw, options = {}) {
    const text = String(raw == null ? "" : raw).trim();
    if (!text) return "";
    const dateOnly =
      DISPLAY_DATE_ONLY ||
      options.dateOnly === true ||
      isFieldDateOnly(options.meta) ||
      (!isDateTimeFieldMeta(options.meta) && options.isDateTime !== true);
    if (dateOnly) {
      return formatUserDate(text) || text;
    }
    return formatUserDateTime(text, options.includeSeconds !== false) || text;
  }

  function parseDate(value) {
    return formatTableDateValue(value);
  }

  function parseCreatedDate(value) {
    return formatTableDateValue(value, { dateOnly: true });
  }

  function toStatusClassName(value) {
    return String(value || "unknown")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown";
  }

  function normalizeStatusToken(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  }

  function toCanonicalStatus(value) {
    const normalized = normalizeStatusToken(value);
    return STATUS_ORDER_CANONICAL_MAP[normalized] || String(value || "").trim();
  }

  function resolveFieldValue(sourceRow, key) {
    if (Object.prototype.hasOwnProperty.call(sourceRow, key)) {
      return sourceRow[key];
    }
    if (key === "SerialNumber") return sourceRow.SerialNumber || sourceRow["SerialNo."] || "";
    if (key === "SerialNo.") return sourceRow["SerialNo."] || sourceRow.SerialNumber || "";
    if (key === "PurchaseAmount") {
      return (
        sourceRow.PurchaseAmount ||
        sourceRow["Purchase Amount"] ||
        sourceRow.Price ||
        sourceRow["Price"] ||
        getRecordFieldValueByInternalNames(sourceRow, ["PurchaseAmount", "Purchase Amount", "Price"]) ||
        ""
      );
    }
    if (key === "AssetManager" || key === "Asset Manager") {
      return (
        sourceRow.AssetManager ||
        sourceRow["Asset Manager"] ||
        sourceRow.AssetManagerName ||
        sourceRow["Asset Manager Name"] ||
        sourceRow.AssetManagerID ||
        sourceRow["Asset Manager ID"] ||
        getRecordFieldValueByInternalNames(sourceRow, [
          "AssetManager",
          "Asset Manager",
          "AssetManagerName",
          "AssetManagerID"
        ]) ||
        ""
      );
    }
    if (key === "Created By") {
      return (
        sourceRow["Created By"] ||
        sourceRow.CreatedByName ||
        sourceRow.CreatedBy ||
        sourceRow.createdBy ||
        sourceRow.CreatedByID ||
        sourceRow.createdByID ||
        sourceRow.createdbyid ||
        sourceRow.createdByGUID ||
        sourceRow.CreatedByGUID ||
        getRecordFieldValueByInternalNames(sourceRow, [
          "CreatedBy",
          "CreatedByID",
          "CreatedByName",
          "CreatedByGUID"
        ]) ||
        ""
      );
    }
    if (key === "Modified By") {
      return (
        sourceRow["Modified By"] ||
        sourceRow.ModifiedByName ||
        sourceRow.ModifiedBy ||
        sourceRow.modifiedBy ||
        sourceRow.LastModifiedBy ||
        sourceRow.lastModifiedBy ||
        sourceRow.LastModifiedByID ||
        sourceRow.lastModifiedByID ||
        sourceRow.lstmOdifiedBy ||
        sourceRow.lstModifiedBy ||
        sourceRow.LastModifiedByGUID ||
        sourceRow.lastModifiedByGUID ||
        getRecordFieldValueByInternalNames(sourceRow, [
          "ModifiedBy",
          "ModifiedByName",
          "ModifiedByID",
          "LastModifiedBy",
          "LastModifiedByName",
          "LastModifiedByID",
          "lstmOdifiedBy",
          "lstModifiedBy"
        ]) ||
        sourceRow.CreatedByName ||
        sourceRow.CreatedBy ||
        sourceRow.createdBy ||
        sourceRow.CreatedByID ||
        sourceRow.createdByID ||
        sourceRow.createdbyid ||
        sourceRow.createdByGUID ||
        sourceRow.CreatedByGUID ||
        getRecordFieldValueByInternalNames(sourceRow, [
          "CreatedBy",
          "CreatedByID",
          "CreatedByName",
          "CreatedByGUID"
        ]) ||
        ""
      );
    }
    if (key === "Created Date") return sourceRow["Created Date"] || sourceRow.CreatedDate || "";
    if (key === "Modified Date") return sourceRow["Modified Date"] || sourceRow.LastModifiedDate || "";
    return "";
  }

  function normalizeAnyValue(value) {
    if (value == null) return "";
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) {
      return value
        .map((item) => normalizeAnyValue(item))
        .filter(Boolean)
        .join(", ");
    }
    if (typeof value === "object") {
      const fullName = [value.FirstName, value.LastName]
        .map((part) => String(part || "").trim())
        .filter(Boolean)
        .join(" ");
      return normalizeAnyValue(
        value.Title ||
          value.Name ||
          value.DisplayName ||
          value.EmployeeName ||
          fullName ||
          value.label ||
          value.value ||
          ""
      );
    }
    const text = String(value).trim();
    if (!text) return "";
    const parsedJson = tryParseJson(text);
    if (Array.isArray(parsedJson)) {
      return parsedJson
        .map((item) => normalizeAnyValue(item))
        .filter(Boolean)
        .join(", ");
    }
    if (parsedJson && typeof parsedJson === "object") {
      return normalizeAnyValue(parsedJson);
    }
    return parseLookupLabel(text);
  }

  function normalizeAssetListRow(row) {
    if (!row || typeof row !== "object") return row;
    const merged = mergeRecordFieldValuesIntoRow(row);
    const recordId = getRecordIDFromRow(merged);
    if (recordId) {
      if (!merged.RecordID) merged.RecordID = recordId;
      return merged;
    }
    const fallbackId = String(merged.ID || merged.Id || "").trim();
    if (fallbackId) {
      merged.RecordID = fallbackId;
      return merged;
    }
    return merged;
  }

  function getStableRecordKey(row) {
    if (!row) return null;
    for (let i = 0; i < RECORD_KEY_FIELDS.length; i += 1) {
      const keyName = RECORD_KEY_FIELDS[i];
      if (row[keyName] != null && String(row[keyName]).trim()) {
        return `${keyName}:${String(row[keyName]).trim()}`;
      }
    }
    const serial = String(row.SerialNumber || row["SerialNo."] || "").trim();
    const name = String(row.AssetName || "").trim();
    if (serial || name) return `sn:${serial}|name:${name}`;
    return null;
  }

  function filterNewRawRowsByDedupe(rawRows) {
    const out = [];
    for (let i = 0; i < rawRows.length; i += 1) {
      const row = rawRows[i];
      const key = getStableRecordKey(row);
      if (key) {
        if (state.seenRecordKeys.has(key)) continue;
        state.seenRecordKeys.add(key);
      }
      out.push(row);
    }
    return out;
  }

  function assetQueryCacheKey(statusValue) {
    const searchKey = normalizeFieldName(state.searchQuery || "").replace(/\s+/g, "_");
    return `${state.categoryId}|${state.typeId || "__type_all__"}|${
      statusValue ? String(statusValue).toLowerCase() : "__all__"
    }|q:${searchKey || "__none__"}`;
  }

  function normalizeQafGetItemsRows(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== "object") return [];
    const list = payload.data || payload.Data || payload.records || payload.Records || payload.result;
    return Array.isArray(list) ? list : [];
  }

  async function fetchQafUsersMapForRecordIds(recordIds, signal) {
    const ids = [...new Set((recordIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) return {};

    const qaf = window.QafService;
    const fieldList = ["RecordID", "FirstName", "LastName"];
    const whereClause = ids.map((id) => `RecordID='${escapeClauseValue(id)}'`).join("<OR>");

    if (qaf && typeof qaf.GetItems === "function") {
      try {
        const payload = await qaf.GetItems("QAF_Users", fieldList, Math.min(500, ids.length * 2 || 50), 1, whereClause, "", true);
        const rows = normalizeQafGetItemsRows(payload);
        return rows.reduce((acc, row) => {
          const id = String(row.RecordID || "").trim();
          if (!id) return acc;
          const fullName = `${row.FirstName || ""} ${row.LastName || ""}`.trim();
          acc[id] = fullName || id;
          return acc;
        }, {});
      } catch (_e) {
        /* fall through to REST */
      }
    }

    const params = new URLSearchParams({
      objectName: "QAF_Users",
      fieldList: "RecordID,FirstName,LastName",
      orderBy: "",
      whereClause,
      pageSize: String(Math.min(500, ids.length * 2 || 50)),
      pageNumber: "1",
      isAscending: "true"
    });
    try {
      const payload = await fetchJson(`${getAppApiBase()}/api/GetRecordsForFields?${params.toString()}`, signal);
      const rows = normalizeRecords(payload);
      return rows.reduce((acc, row) => {
        const id = String(row.RecordID || "").trim();
        if (!id) return acc;
        const fullName = `${row.FirstName || ""} ${row.LastName || ""}`.trim();
        acc[id] = fullName || id;
        return acc;
      }, {});
    } catch (_error) {
      return {};
    }
  }

  async function fetchEmployeesMapForAssignedTo(rawRows, signal) {
    const recordIds = [
      ...new Set(
        (rawRows || []).flatMap((row) => [
          ...parseAssignedRecordIds(resolveFieldValue(row, "AssignedTo") || row.AssignedTo),
          ...collectAssetManagerIds(row)
        ])
      )
    ];
    return fetchQafUsersMapForRecordIds(recordIds, signal);
  }

  async function mergeEmployeesFromRows(rawRows, signal) {
    if (String(state.searchQuery || "").trim()) return;
    const delta = await fetchEmployeesMapForAssignedTo(rawRows, signal);
    Object.assign(state.employeesMap, delta);
  }

  async function refreshEmployeesMapFromApi(signal) {
    const params = new URLSearchParams({
      objectName: "QAF_Users",
      fieldList: "RecordID,FirstName,LastName",
      orderBy: "",
      whereClause: "",
      pageSize: "500",
      pageNumber: "1",
      isAscending: "true"
    });
    const payload = await fetchJson(
      `${getAppApiBase()}/api/GetRecordsForFields?${params.toString()}`,
      signal
    );
    const rows = normalizeRecords(payload);
    const map = {};
    rows.forEach((row) => {
      const id = String(row.RecordID || "").trim();
      if (!id) return;
      const fullName = `${row.FirstName || ""} ${row.LastName || ""}`.trim();
      map[id] = fullName || id;
    });
    state.employeesMap = map;
  }

  function decodeRouteLabelFromUrl(value) {
    return String(value || "")
      .trim()
      .replace(/_/g, " ");
  }

  function safeDecodeRouteParam(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    try {
      return decodeURIComponent(text.replace(/\+/g, " "));
    } catch (_error) {
      return text;
    }
  }

  function getFirstQueryParam(params, keys) {
    for (let i = 0; i < keys.length; i += 1) {
      const raw = params.get(keys[i]);
      if (raw != null && String(raw).trim() !== "") return raw;
    }
    return "";
  }

  /** Read a query value from the raw search string so `;` inside `guid;label` is preserved. */
  function readRouteParamFromSearch(search, keys) {
    const query = String(search || "");
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      const match = query.match(new RegExp(`(?:^|[?&])${key}=([^&]*)`, "i"));
      if (match && String(match[1] || "").trim() !== "") {
        return safeDecodeRouteParam(match[1]);
      }
    }
    const params = new URLSearchParams(query);
    return safeDecodeRouteParam(getFirstQueryParam(params, keys));
  }

  /** Parses `category` / `type` query values: `{guid};{label_with_underscores}` or `{guid};#{label}`. */
  function parseRouteLookupParam(raw) {
    const text = safeDecodeRouteParam(raw);
    if (!text) return { id: "", label: "" };
    const hashSep = text.indexOf(";#");
    if (hashSep !== -1) {
      return {
        id: text.slice(0, hashSep).trim(),
        label: decodeRouteLabelFromUrl(text.slice(hashSep + 2))
      };
    }
    const sep = text.indexOf(";");
    if (sep === -1) {
      if (isGuid(text)) return { id: text, label: "" };
      return { id: "", label: decodeRouteLabelFromUrl(text) };
    }
    const idPart = text.slice(0, sep).trim();
    const labelPart = decodeRouteLabelFromUrl(text.slice(sep + 1));
    if (isGuid(idPart)) return { id: idPart, label: labelPart };
    if (isGuid(labelPart)) return { id: labelPart, label: decodeRouteLabelFromUrl(idPart) };
    return { id: "", label: decodeRouteLabelFromUrl(text) };
  }

  function getRouteParams() {
    const search = window.location.search || "";
    const params = new URLSearchParams(search);
    const category = parseRouteLookupParam(
      readRouteParamFromSearch(search, ["category"])
    );
    const type = parseRouteLookupParam(readRouteParamFromSearch(search, ["type"]));
    const countRaw = getFirstQueryParam(params, [
      "count"
    ]);
    const assetCount =
      countRaw != null && String(countRaw).trim() !== "" ? Number(countRaw) : null;
    const legacyCategoryName = decodeRouteLabelFromUrl(
      safeDecodeRouteParam(params.get("categoryName") || "")
    );
    const categoryName =
      category.label ||
      legacyCategoryName ||
      (category.id ? "" : DEFAULT_CATEGORY_LABEL);
    return {
      categoryId: category.id,
      categoryName,
      typeId: type.id,
      typeName: type.label,
      assetCount: Number.isFinite(assetCount) ? assetCount : null
    };
  }

  function shouldHardBlockAssetFetch() {
    if (state.routeHasZeroAssets) return true;
    return !String(state.categoryId || "").trim() && !String(state.categoryLabel || "").trim();
  }

  function tryParseJson(input) {
    try {
      return JSON.parse(input);
    } catch (_error) {
      return null;
    }
  }

  function normalizeNewLpEntry(value) {
    return String(value == null ? "" : value)
      .trim()
      .replace(/^["']+|["']+$/g, "");
  }

  function readNewLpEntries() {
    if (window.QafNavDock && typeof window.QafNavDock.parseNewLpEntries === "function") {
      return window.QafNavDock.parseNewLpEntries();
    }

    let raw = "";
    try {
      raw = localStorage.getItem("NewLP") || "";
    } catch (_error) {
      raw = "";
    }

    if (!raw) {
      try {
        const userKeyRaw = localStorage.getItem("user_key");
        if (userKeyRaw) {
          const userKey = tryParseJson(userKeyRaw);
          if (userKey && userKey.NewLP != null) raw = userKey.NewLP;
        }
      } catch (_error2) {
        // Fall through.
      }
    }

    if (!raw) return [];

    if (Array.isArray(raw)) {
      return raw.map(normalizeNewLpEntry).filter(Boolean);
    }

    const asString = String(raw).trim();
    if (!asString) return [];

    const parsedJson = tryParseJson(asString);
    if (Array.isArray(parsedJson)) {
      return parsedJson.map(normalizeNewLpEntry).filter(Boolean);
    }

    return asString
      .split(",")
      .map(normalizeNewLpEntry)
      .filter(Boolean);
  }

  function hasAnyNewLp(entries, allowedList) {
    const list = Array.isArray(entries) ? entries : [];
    const allowed = Array.isArray(allowedList) ? allowedList : [];
    for (let i = 0; i < allowed.length; i += 1) {
      const needle = normalizeNewLpEntry(allowed[i]);
      if (!needle) continue;
      for (let j = 0; j < list.length; j += 1) {
        if (normalizeNewLpEntry(list[j]) === needle) return true;
      }
    }
    return false;
  }

  function buildUnauthorizedRedirectUrl() {
    let ma = "";
    try {
      ma = String(localStorage.getItem("ma") || "").trim();
    } catch (_error) {
      ma = "";
    }

    if (!ma) return "/not-found?unauthorized=un";

    if (!/^https?:\/\//i.test(ma)) {
      const protocol = (window.location && window.location.protocol) || "https:";
      ma = `${protocol}//${ma.replace(/^\/+/, "")}`;
    }

    try {
      return `${new URL(ma).origin}/not-found?unauthorized=un`;
    } catch (_error2) {
      return `https://${String(localStorage.getItem("ma") || "").replace(/^\/+/, "")}/not-found?unauthorized=un`;
    }
  }

  function isPageAuthorized() {
    return hasAnyNewLp(readNewLpEntries(), PAGE_ACCESS_NEW_LP);
  }

  function getUserKeyPayload() {
    const parsed = tryParseJson(localStorage.getItem("user_key") || "");
    const parsedValue =
      parsed && typeof parsed.value === "string" ? tryParseJson(parsed.value) : parsed && parsed.value;
    return (
      (parsedValue && typeof parsedValue === "object" && parsedValue) ||
      (parsed && typeof parsed === "object" && parsed) ||
      {}
    );
  }

  function getCurrentEmployeeGuid() {
    const payload = getUserKeyPayload();
    return String(payload.employeeguid || payload.EmployeeGUID || "")
      .trim()
      .toLowerCase();
  }

  function hasFullAccessNewLp() {
    return hasAnyNewLp(readNewLpEntries(), FULL_ACCESS_NEW_LP);
  }

  function hasReadOnlyNewLp() {
    return hasAnyNewLp(readNewLpEntries(), ["22-1"]) && !hasFullAccessNewLp();
  }

  function hasAssetManagerEditNewLp() {
    return hasAnyNewLp(readNewLpEntries(), ["22-2"]) && !hasFullAccessNewLp();
  }

  function isToolbarCreationRestricted() {
    return hasReadOnlyNewLp() || hasAssetManagerEditNewLp();
  }

  function getEmployeeGuidForRecordId(recordId) {
    const key = String(recordId || "").trim().toLowerCase();
    if (!key) return "";
    return String(state.recordIdToEmployeeGuid[key] || "").trim().toLowerCase();
  }

  function collectAssetManagerIds(rawRow) {
    const ids = [];
    if (!rawRow || typeof rawRow !== "object") return ids;

    function pushIds(raw) {
      if (raw == null || raw === "") return;
      const text = String(raw).trim();
      if (text.includes(";#")) {
        const lookupId = String(parseLookupId(text) || "").trim();
        if (lookupId) ids.push(lookupId);
      }
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
        ids.push(text);
      }
      parseAssignedRecordIds(raw).forEach((id) => {
        if (id) ids.push(id);
      });
    }

    pushIds(resolveFieldValue(rawRow, "AssetManager"));
    pushIds(resolveFieldValue(rawRow, "Asset Manager"));

    const rfv = Array.isArray(rawRow.RecordFieldValues) ? rawRow.RecordFieldValues : [];
    rfv.forEach((entry) => {
      const label = String(
        entry.FieldInternalName || entry.dsNm || entry.FieldName || entry.dn || ""
      ).trim();
      if (normalizeLooseFieldName(label) !== "assetmanager") return;
      const raw =
        entry.UGFieldValue ??
        entry.UGFfieldValue ??
        entry.FieldValue ??
        entry.UFieldValue ??
        entry.Value ??
        "";
      pushIds(raw);
    });

    const seen = new Set();
    return ids.filter((id) => {
      const token = String(id || "").trim();
      if (!token || seen.has(token)) return false;
      seen.add(token);
      return true;
    });
  }

  function getPermissionRawRowByRecordKey(recordKey) {
    const key = String(recordKey || "").trim();
    if (!key) return null;
    if (state.rawRowsByRecordKey[key]) return state.rawRowsByRecordKey[key];
    const formatted = state.filteredRows.find((item) => item && item.__recordKey === key);
    if (!formatted) return null;
    const recordId = String(formatted.__recordID || "").trim();
    if (!recordId) return null;
    const cachedRows = Object.values(state.rawRowsByRecordKey || {});
    for (let i = 0; i < cachedRows.length; i += 1) {
      const row = cachedRows[i];
      if (String(getRecordIDFromRow(row) || "").trim() === recordId) return row;
    }
    return null;
  }

  function getPermissionRawRow(displayRow) {
    if (!displayRow) return null;
    return getPermissionRawRowByRecordKey(displayRow.__recordKey);
  }

  function isCurrentUserAssetManagerForRow(rawRow) {
    const currentGuid = getCurrentEmployeeGuid();
    if (!currentGuid) return false;

    const managerIds = collectAssetManagerIds(rawRow);
    if (!managerIds.length) return false;

    for (let i = 0; i < managerIds.length; i += 1) {
      const managerId = String(managerIds[i]).trim().toLowerCase();
      if (!managerId) continue;
      if (managerId === currentGuid) return true;
      const resolvedGuid = getEmployeeGuidForRecordId(managerId);
      if (resolvedGuid && resolvedGuid === currentGuid) return true;
    }
    return false;
  }

  function canEditAsset(rawRow) {
    if (hasFullAccessNewLp()) return true;
    if (hasReadOnlyNewLp()) return false;
    if (hasAssetManagerEditNewLp()) return isCurrentUserAssetManagerForRow(rawRow);
    return false;
  }

  function canAssignOrDeallocateAsset(rawRow) {
    return canEditAsset(rawRow);
  }

  function canDeleteAsset(_rawRow) {
    return hasFullAccessNewLp();
  }

  async function resolveEmployeeGuidsForRecordIds(recordIds, signal) {
    const uniqueIds = [
      ...new Set((Array.isArray(recordIds) ? recordIds : []).map((id) => String(id || "").trim()).filter(Boolean))
    ];
    const missing = uniqueIds.filter((id) => !getEmployeeGuidForRecordId(id));
    if (!missing.length) return;

    const whereClause = missing
      .flatMap((id) => {
        const escaped = escapeClauseValue(id);
        return [
          `RecordID='${escaped}'`,
          `UserID='${escaped}'`,
          `EmployeeGUID='${escaped}'`,
          `EmployeeID='${escaped}'`
        ];
      })
      .join("<OR>");

    const objectNames = ["QAF_Users", "Employees"];
    for (let i = 0; i < objectNames.length; i += 1) {
      const objectName = objectNames[i];
      const fieldList =
        objectName === "QAF_Users"
          ? "RecordID,UserID,EmployeeGUID,EmployeeID"
          : "RecordID,EmployeeGUID,EmployeeID";
      try {
        const params = new URLSearchParams({
          objectName,
          fieldList,
          orderBy: "",
          whereClause,
          pageSize: String(Math.min(500, missing.length * 4 || 50)),
          pageNumber: "1",
          isAscending: "true"
        });
        const payload = await fetchJson(
          `${getAppApiBase()}/api/GetRecordsForFields?${params.toString()}`,
          signal
        );
        const rows = normalizeRecords(payload);
        rows.forEach((row) => {
          const employeeGuid = String(row.EmployeeGUID || row.EmployeeGuid || "")
            .trim()
            .toLowerCase();
          if (!employeeGuid) return;
          const recordId = String(row.RecordID || "").trim().toLowerCase();
          const userId = String(row.UserID || "").trim().toLowerCase();
          const employeeId = String(row.EmployeeID || "").trim().toLowerCase();
          [recordId, userId, employeeId, employeeGuid].forEach((key) => {
            if (!key) return;
            if (missing.some((id) => String(id).trim().toLowerCase() === key)) {
              state.recordIdToEmployeeGuid[key] = employeeGuid;
            }
          });
        });
      } catch (_error) {
        // Try next object name.
      }
    }
  }

  async function warmAssetManagerGuidCache(rawRows, signal) {
    if (!hasAssetManagerEditNewLp()) return;
    const ids = [];
    (Array.isArray(rawRows) ? rawRows : []).forEach((rawRow) => {
      collectAssetManagerIds(rawRow).forEach((id) => {
        if (id && !getEmployeeGuidForRecordId(id)) ids.push(id);
      });
    });
    if (!ids.length) return;
    await resolveEmployeeGuidsForRecordIds(ids, signal);
    renderTable();
  }

  function syncRestrictedToolbarButtons() {
    const restricted = isToolbarCreationRestricted();
    [ui.newAssetBtn, ui.moreBtn].forEach((btn) => {
      if (!btn) return;
      btn.disabled = false;
      btn.setAttribute("aria-disabled", restricted ? "true" : "false");
      btn.classList.toggle("is-toolbar-restricted", restricted);
    });
  }

  function getAuthHeaders() {
    const payload = getUserKeyPayload();
    return {
      "Content-Type": "application/json",
      employeeguid: payload.employeeguid || payload.EmployeeGUID || "",
      hrzemail: payload.hrzemail || payload.Email || "",
      hrzempid: payload.hrzempid || payload.EmployeeID || "",
      lngs: payload.lngs || "Asia/Kolkata"
    };
  }

  function normalizeRecords(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || payload === false) return [];
    if (Array.isArray(payload.List)) return payload.List;
    if (Array.isArray(payload.Items)) return payload.Items;
    const list =
      payload.data ||
      payload.Data ||
      payload.records ||
      payload.Records ||
      payload.result ||
      payload.Result ||
      payload.rows ||
      payload.Rows ||
      payload.items ||
      payload.value ||
      payload.Value;
    if (Array.isArray(list)) return list;
    if (list && typeof list === "object") {
      if (Array.isArray(list.data)) return list.data;
      if (Array.isArray(list.Data)) return list.Data;
      if (Array.isArray(list.records)) return list.records;
      if (Array.isArray(list.Records)) return list.Records;
    }
    return [];
  }

  /** Reads `TotalRecords` from an `api/rnsp` payload, whatever wrapper shape it comes back in. Returns null when absent/invalid so callers can fall back to the page-size heuristic. */
  function getTotalRecordsFromPayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const candidates = [
      payload.TotalRecords,
      payload.totalRecords,
      payload.TotalRecord,
      payload.Total,
      payload.total
    ];
    const nested = payload.data || payload.Data || payload.result || payload.Result;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      candidates.push(nested.TotalRecords, nested.totalRecords, nested.Total, nested.total);
    }
    for (let i = 0; i < candidates.length; i += 1) {
      const num = Number(candidates[i]);
      if (candidates[i] != null && candidates[i] !== "" && Number.isFinite(num)) return num;
    }
    return null;
  }

  function normalizeFieldName(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function normalizeLooseFieldName(value) {
    return String(value || "")
      .replace(/[^a-z0-9]/gi, "")
      .trim()
      .toLowerCase();
  }

  function isAssetNameColumn(column) {
    if (!column || !column.key) return false;
    const keyNorm = normalizeFieldName(column.key);
    const labelNorm = normalizeFieldName(column.label || "");
    const looseKey = normalizeLooseFieldName(column.key);
    return (
      keyNorm === "asset name" ||
      keyNorm === "assetname" ||
      labelNorm === "asset name" ||
      looseKey === "assetname"
    );
  }

  function toGetItemMatchKey(fieldName) {
    const text = String(fieldName || "").trim();
    if (!text || !/\s/.test(text)) return text;
    return text.replace(/\s+/g, "");
  }

  function getViewFieldProp(viewField, ...keys) {
    if (!viewField || typeof viewField !== "object") return "";
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (viewField[key] != null && String(viewField[key]).trim() !== "") {
        return viewField[key];
      }
      const lower = String(key || "").toLowerCase();
      const matchedKey = Object.keys(viewField).find((entry) => String(entry).toLowerCase() === lower);
      if (
        matchedKey &&
        viewField[matchedKey] != null &&
        String(viewField[matchedKey]).trim() !== ""
      ) {
        return viewField[matchedKey];
      }
    }
    return "";
  }

  function toDisplayLabel(key) {
    const raw = String(key || "").trim();
    if (!raw) return "";
    if (/\s/.test(raw)) return raw;
    return raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getViewFieldFid(viewField) {
    return String(getViewFieldProp(viewField, "fid", "Fid", "FieldID", "FieldId") || "").trim();
  }

  function getViewFieldDataType(viewField) {
    return String(getViewFieldProp(viewField, "dtp", "Dtp", "DataType") || "")
      .trim()
      .toUpperCase();
  }

  function getViewFieldKey(viewField) {
    return String(
      getViewFieldProp(
        viewField,
        "dsNm",
        "DsNm",
        "FieldInternalName",
        "InternalName",
        "FieldName",
        "Name"
      ) || ""
    ).trim();
  }

  function getViewFieldLabel(viewField, fallbackKey) {
    const dsNm = getViewFieldKey(viewField);
    if (dsNm) return dsNm;
    return String(
      getViewFieldProp(viewField, "dn", "Dn", "DisplayName", "FieldName", "Name") ||
        toDisplayLabel(fallbackKey)
    ).trim();
  }

  function getViewFieldSeq(viewField) {
    const seq = Number(getViewFieldProp(viewField, "seq", "Seq"));
    return Number.isFinite(seq) ? seq : Number.MAX_SAFE_INTEGER;
  }

  function sortViewFieldsBySeq(viewFields) {
    return (Array.isArray(viewFields) ? viewFields : [])
      .slice()
      .sort((a, b) => getViewFieldSeq(a) - getViewFieldSeq(b));
  }

  function getViewFieldMatchCandidates(viewField) {
    const dsNm = getViewFieldKey(viewField);
    const fid = getViewFieldFid(viewField);
    const dn = String(getViewFieldProp(viewField, "dn", "Dn", "DisplayName") || "").trim();
    const ordered = [];
    const add = (value) => {
      const text = String(value || "").trim();
      if (!text) return;
      if (!ordered.includes(text)) ordered.push(text);
      const compact = toGetItemMatchKey(text);
      if (compact && compact !== text && !ordered.includes(compact)) ordered.push(compact);
    };
    add(dsNm);
    add(fid);
    if (dn && dn !== dsNm) add(dn);
    return ordered;
  }

  function getViewFieldFetchNames(viewField) {
    return getViewFieldMatchCandidates(viewField);
  }

  function parseAssetViewFields(rawValue) {
    const parsed = typeof rawValue === "string" ? tryParseJson(rawValue) : rawValue;
    return Array.isArray(parsed) ? parsed : [];
  }

  function getCachedAssetViewFields() {
    return Array.isArray(state.assetViewFields) ? state.assetViewFields : [];
  }

  function getViewFieldsFetchFieldList() {
    const viewFields = getCachedAssetViewFields();
    const out = [];
    const seen = new Set();
    const add = (name) => {
      const value = String(name || "").trim();
      if (!value || seen.has(value)) return;
      seen.add(value);
      out.push(value);
    };
    viewFields.forEach((viewField) => {
      getViewFieldFetchNames(viewField).forEach(add);
    });
    return out;
  }

  function buildRowKeyMap(flattenedRows) {
    const keyMap = {};
    const rows = Array.isArray(flattenedRows) ? flattenedRows : [];
    for (let r = 0; r < rows.length; r += 1) {
      const row = rows[r];
      if (!row || typeof row !== "object") continue;
      Object.keys(row).forEach((key) => {
        const normalized = normalizeLooseFieldName(key);
        if (normalized && !keyMap[normalized]) keyMap[normalized] = key;
        const compactKey = toGetItemMatchKey(key);
        if (compactKey && compactKey !== key) {
          const compactNormalized = normalizeLooseFieldName(compactKey);
          if (compactNormalized && !keyMap[compactNormalized]) keyMap[compactNormalized] = key;
        }
      });
    }
    return keyMap;
  }

  function resolveRowKeyForViewField(viewField, keyMap) {
    const candidates = getViewFieldMatchCandidates(viewField);
    for (let i = 0; i < candidates.length; i += 1) {
      const normalized = normalizeLooseFieldName(candidates[i]);
      if (normalized && keyMap[normalized]) return keyMap[normalized];
    }
    const dsNm = getViewFieldKey(viewField);
    const dn = String(getViewFieldProp(viewField, "dn", "Dn", "DisplayName") || "").trim();
    return toGetItemMatchKey(dsNm) || toGetItemMatchKey(dn) || dsNm || dn || "";
  }

  function isSerialNumberColumn(column) {
    if (!column || !column.key) return false;
    const loose = normalizeLooseFieldName(column.key);
    return loose === "serialnumber" || loose === "serialno";
  }

  function enrichColumnDef(baseDef) {
    if (!baseDef || !baseDef.key) return null;
    const meta = baseDef.meta || getFieldMetaForColumnKey(baseDef.key);
    const internalName = String((meta && meta.internalName) || baseDef.internalName || baseDef.key).trim();
    const displayName = String((meta && meta.displayName) || baseDef.label || baseDef.key).trim();
    const loose = normalizeLooseFieldName(internalName || baseDef.key);
    return {
      key: baseDef.key,
      label: displayName || baseDef.label || baseDef.key,
      internalName,
      displayName,
      viewDsNm: baseDef.viewDsNm || "",
      isDate: baseDef.isDate === true || isDateFieldMeta(meta),
      isDateOnly: baseDef.isDateOnly === true || isFieldDateOnly(meta),
      isDateTime: baseDef.isDateTime === true || isDateTimeFieldMeta(meta),
      isCurrency: baseDef.isCurrency === true || isCurrencyFieldMeta(meta),
      isBadge: baseDef.isBadge === true || loose === "itemstatus"
    };
  }

  function buildDynamicColumnDef(viewField, rowKeyMap) {
    const viewDsNm = getViewFieldKey(viewField);
    const fid = getViewFieldFid(viewField);
    const dtp = getViewFieldDataType(viewField);
    const label = getViewFieldLabel(viewField, viewDsNm);
    if (!viewDsNm) return null;

    const cachedMeta = state.objectFieldMetaById && fid ? state.objectFieldMetaById[fid] : null;
    const fidLooksLikeInternalName = fid && !/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(fid);
    const internalName = String(
      (cachedMeta && cachedMeta.internalName) ||
        (fidLooksLikeInternalName ? fid : "") ||
        toGetItemMatchKey(viewDsNm) ||
        viewDsNm
    ).trim();

    const resolvedKey = rowKeyMap ? resolveRowKeyForViewField(viewField, rowKeyMap) : "";
    const key =
      resolvedKey ||
      internalName ||
      toGetItemMatchKey(viewDsNm) ||
      viewDsNm;
    if (!key) return null;

    const loose = normalizeLooseFieldName(viewDsNm);
    const looseFid = normalizeLooseFieldName(fid);
    return enrichColumnDef({
      key,
      label: label || viewDsNm,
      internalName,
      displayName: label || viewDsNm,
      viewDsNm,
      isDate:
        dtp === "DTE" ||
        dtp === "DTM" ||
        loose.endsWith("date") ||
        looseFid.endsWith("date") ||
        loose === "receivedon",
      isDateOnly: dtp === "DTE",
      isDateTime: dtp === "DTM",
      isBadge: loose === "itemstatus",
      meta: cachedMeta || null
    });
  }

  function buildColumnsFromViewFields(viewFields, rowKeyMap) {
    const seen = new Set();
    const columns = [];
    sortViewFieldsBySeq(viewFields).forEach((viewField) => {
      const viewDsNm = getViewFieldKey(viewField);
      if (!viewDsNm) return;
      const identityKey = normalizeLooseFieldName(viewDsNm);
      if (!identityKey || seen.has(identityKey)) return;
      seen.add(identityKey);

      const col = buildDynamicColumnDef(viewField, rowKeyMap);
      if (col) columns.push(col);
    });
    return columns;
  }

  function reconcileColumnKeysFromRows(rows) {
    if (!Array.isArray(state.columnDefs) || !state.columnDefs.length) return false;
    if (!Array.isArray(rows) || !rows.length) return false;
    const mergedRows = rows.map((row) => mergeRecordFieldValuesIntoRow(row));
    const keyMap = buildRowKeyMap(mergedRows);
    let changed = false;
    const next = state.columnDefs.map((column) => {
      if (!column || !column.key) return column;
      const viewDsNm = String(column.viewDsNm || column.internalName || column.key).trim();
      const pseudoViewField = { DsNm: viewDsNm, Dn: column.label || "" };
      const resolvedKey = resolveRowKeyForViewField(pseudoViewField, keyMap);
      if (resolvedKey && resolvedKey !== column.key) {
        changed = true;
        return { ...column, key: resolvedKey };
      }
      return column;
    });
    if (changed) {
      state.columnDefs = next;
    }
    return changed;
  }

  function getMasterObjectIdSync() {
    return state.masterObjectId || MASTER_EDIT_FORM.objectId || ASSET_OBJECT_ID;
  }

  function getMasterObjectLookupCandidates() {
    return [
      ...new Set(
        [
          MASTER_LIST_OBJECT_NAME,
          MASTER_EDIT_FORM.repository,
          MASTER_EDIT_FORM.formName,
          MASTER_EDIT_FORM.objectId,
          ASSET_OBJECT_ID
        ]
          .map((item) => String(item || "").trim())
          .filter(Boolean)
      )
    ];
  }

  function cacheMasterObjectRow(row) {
    if (!row || typeof row !== "object") return;
    state.masterObjectRow = row;
    const objectId = String(row.ObjectID || row.ObjectId || "").trim();
    if (objectId) {
      state.masterObjectId = objectId;
      MASTER_EDIT_FORM.objectId = objectId;
    }
  }

  function buildObjectFieldMetaMaps(fields) {
    const map = {};
    const byInternalName = {};
    const byDisplayName = {};
    (Array.isArray(fields) ? fields : []).forEach((field) => {
      const fid = String(field.FieldID || "").trim();
      if (!fid) return;
      const entry = {
        fieldID: fid,
        internalName: String(field.InternalName || "").trim(),
        displayName: String(field.DisplayName || "").trim(),
        dataType: String(field.DataType || "").trim(),
        required: field.Required === true,
        isReadOnly: field.IsReadOnly === true,
        isCurrency: field.IsCurrency === true,
        dateOnly: field.DateOnly === true,
        lookupObject: String(field.LookupObject || "").trim(),
        lookupObjectField1: String(field.LookupObjectField1 || "").trim()
      };
      map[fid] = entry;
      const normalizedInternal = normalizeFieldName(entry.internalName);
      const normalizedDisplay = normalizeFieldName(entry.displayName);
      if (normalizedInternal) byInternalName[normalizedInternal] = entry;
      if (normalizedDisplay) byDisplayName[normalizedDisplay] = entry;
    });
    return { map, byInternalName, byDisplayName };
  }

  function isMasterRepositoryName(name) {
    const key = String(name || "").trim().toLowerCase();
    if (!key) return false;
    return [
      MASTER_LIST_OBJECT_NAME,
      MASTER_EDIT_FORM.repository,
      MASTER_EDIT_FORM.formName,
      "easset master"
    ].some((candidate) => String(candidate || "").trim().toLowerCase() === key);
  }

  async function fetchMasterObjectRow(signal) {
    if (state.masterObjectRow) return state.masterObjectRow;
    if (masterObjectFetchPromise) return masterObjectFetchPromise;

    masterObjectFetchPromise = (async () => {
      const uniqueCandidates = getMasterObjectLookupCandidates();
      for (let i = 0; i < uniqueCandidates.length; i += 1) {
        try {
          const payload = await fetchJson(
            `${getAppApiBase()}/api/ObjectGet?option=object&objectID=${encodeURIComponent(uniqueCandidates[i])}`,
            signal
          );
          const rows = normalizeRecords(payload);
          const first = rows[0] || {};
          const objectId = String(first.ObjectID || first.ObjectId || "").trim();
          const fields = Array.isArray(first.Fields) ? first.Fields : [];
          if (objectId || fields.length) {
            cacheMasterObjectRow(first);
            return first;
          }
        } catch (_error) {
          // Try next tenant-safe object identifier.
        }
      }
      return null;
    })().finally(() => {
      masterObjectFetchPromise = null;
    });

    return masterObjectFetchPromise;
  }

  async function getMasterObjectId(signal) {
    if (state.masterObjectId) return state.masterObjectId;
    await fetchMasterObjectRow(signal);
    return getMasterObjectIdSync();
  }

  async function ensureObjectFieldMeta(signal) {
    if (state.objectFieldMetaById) return state.objectFieldMetaById;

    let fields = [];
    const cachedRow = await fetchMasterObjectRow(signal);
    if (cachedRow && Array.isArray(cachedRow.Fields) && cachedRow.Fields.length) {
      fields = cachedRow.Fields;
    } else {
      const objectID = await getMasterObjectId(signal);
      const payload = await fetchJson(
        `${getAppApiBase()}/api/ObjectGet?option=object&objectID=${encodeURIComponent(objectID)}`,
        signal
      );
      const rows = normalizeRecords(payload);
      const first = rows[0] || {};
      cacheMasterObjectRow(first);
      fields = Array.isArray(first.Fields) ? first.Fields : [];
    }

    const { map, byInternalName, byDisplayName } = buildObjectFieldMetaMaps(fields);
    state.objectFieldMetaById = map;
    state.objectFieldMetaByInternalName = byInternalName;
    state.objectFieldMetaByDisplayName = byDisplayName;
    return map;
  }

  function getRecordIDFromRow(row) {
    return String(
      (row && (row.RecordID || row.recordid || row.RecordId || row.ID || row.Id)) || ""
    ).trim();
  }

  function getRecordKeyFromRow(row) {
    const direct = getStableRecordKey(row);
    if (direct) return direct;
    const recordID = getRecordIDFromRow(row);
    if (recordID) return `RecordID:${recordID}`;
    return null;
  }

  function getInternalNameForColumnKey(columnKey) {
    return COLUMN_KEY_TO_INTERNAL_NAME[columnKey] || columnKey;
  }

  function getFieldMetaForColumnKey(columnKey) {
    const normalizedInternal = normalizeFieldName(getInternalNameForColumnKey(columnKey));
    const normalizedDisplay = normalizeFieldName(columnKey);
    const direct =
      (state.objectFieldMetaByInternalName && state.objectFieldMetaByInternalName[normalizedInternal]) ||
      (state.objectFieldMetaByDisplayName && state.objectFieldMetaByDisplayName[normalizedDisplay]) ||
      null;
    if (direct) return direct;

    const looseInternal = normalizeLooseFieldName(getInternalNameForColumnKey(columnKey));
    const looseDisplay = normalizeLooseFieldName(columnKey);
    const byId = state.objectFieldMetaById || {};
    const entries = Object.values(byId);
    for (let i = 0; i < entries.length; i += 1) {
      const meta = entries[i] || {};
      const metaInternal = normalizeLooseFieldName(meta.internalName);
      const metaDisplay = normalizeLooseFieldName(meta.displayName);
      if (
        (looseInternal && (metaInternal === looseInternal || metaDisplay === looseInternal)) ||
        (looseDisplay && (metaInternal === looseDisplay || metaDisplay === looseDisplay))
      ) {
        return meta;
      }
    }
    return null;
  }

  function applyDynamicLabelsToColumns(columns) {
    const list = Array.isArray(columns) ? columns : [];
    return list.map((column) => {
      if (!column || !column.key) return column;
      const meta = getFieldMetaForColumnKey(column.key);
      const dynamicLabel = String(meta && meta.displayName ? meta.displayName : "").trim();
      if (!dynamicLabel) return column;
      if (dynamicLabel === String(column.label || "").trim()) return column;
      return { ...column, label: dynamicLabel };
    });
  }

  /** Looks up DOUBLETAP_FIELD_DATATYPE by normalized field name, so remaps like AssetManager -> "Asset Manager" (see COLUMN_KEY_TO_INTERNAL_NAME) still resolve correctly. */
  function getDoubleTapDataTypeForInternalName(internalName) {
    return DOUBLETAP_FIELD_DATATYPE[normalizeLooseFieldName(internalName)];
  }

  let doubleTapLookupDataPromise = null;
  let doubleTapLookupDataCache = null;

  /**
   * Fetches inline-edit dropdown options from the no-Args `ASSET_TYPE_DOUBLETAP_DATA` workflow,
   * grouped dynamically by whatever `DataType` buckets the response actually contains (currently
   * AssetType/Category/Vendor/Department/Employee/Team/Location, but nothing here assumes that
   * fixed set). Lazy: only called the first time a user double-taps one of the mapped cells to
   * edit it (see fetchLookupOptionsForMeta/buildEditorForCell below), never on page load.
   * Single-flight + cached on success so every subsequent double-tap across any mapped field
   * reuses the same result instead of re-fetching - this workflow is called at most once per
   * session. Each row carries `Value` (the exact raw value the update workflow needs - a
   * `"GUID;#Label"` string for most fields, a JSON array string for Employee/Team) and
   * `DisplayValue` (what the user should see) as two separate fields; `Value` is stored and
   * returned completely untouched, never split/parsed/reconstructed. `DisplayValue` falls back to
   * parseLookupLabel(Value) only if the backend ever omits it, so display never breaks.
   */
  async function fetchDoubleTapLookupData(signal) {
    if (doubleTapLookupDataCache) return doubleTapLookupDataCache;
    if (doubleTapLookupDataPromise) return doubleTapLookupDataPromise;

    doubleTapLookupDataPromise = (async () => {
      try {
        const payload = await postJson(`${getAppApiBase()}/api/rnsp`, { Name: DOUBLETAP_DATA_RNSP_NAME }, signal);
        const rows = normalizeRecords(payload);
        const grouped = {};
        rows.forEach((row) => {
          const dataType = String(row && row.DataType != null ? row.DataType : "").trim();
          const rawValue = row && row.Value != null ? row.Value : "";
          const valueKey = String(rawValue).trim();
          if (!dataType || !valueKey) return;
          const displayValueRaw = row && row.DisplayValue != null ? row.DisplayValue : "";
          const displayValue = String(displayValueRaw).trim() || parseLookupLabel(valueKey);
          if (!grouped[dataType]) grouped[dataType] = new Map();
          if (!grouped[dataType].has(valueKey)) {
            grouped[dataType].set(valueKey, { value: rawValue, displayValue });
          }
        });
        const result = {};
        Object.keys(grouped).forEach((key) => {
          result[key] = Array.from(grouped[key].values());
        });
        doubleTapLookupDataCache = result;
        return result;
      } catch (error) {
        if (error && error.name === "AbortError") throw error;
        console.error("ASSET_TYPE_DOUBLETAP_DATA fetch failed:", error);
        // Not cached - a later double-tap gets a fresh retry rather than being stuck empty.
        return {};
      }
    })();

    try {
      return await doubleTapLookupDataPromise;
    } finally {
      doubleTapLookupDataPromise = null;
    }
  }

  /** Turns one DataType bucket's {value, displayValue} entries into sorted {label, rawValue} options: label is the backend's DisplayValue, rawValue is Value completely untouched (sent as-is to the update workflow). */
  function buildOptionsFromDoubleTapBucket(data, dataType) {
    const entries = data && Array.isArray(data[dataType]) ? data[dataType] : [];
    return entries
      .map((entry) => ({ label: entry.displayValue, rawValue: entry.value }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  /**
   * Lookup dropdown options for inline cell editing. Type/Category/VendorID/Department are
   * sourced from `ASSET_TYPE_DOUBLETAP_DATA` (the complete, dynamic value list for those four
   * fields; AssignedTo/AssetManager/SupportedBy/ManagedBy/SupportedByGroup/ManagedByGroup are
   * handled separately in buildEditorForCell, since they don't go through isLookupField). Any
   * other lookup-type column (e.g. Location, Project - not covered by that workflow) still
   * derives its options from the asset rows already fetched via `api/rnsp`
   * (state.rawRowsByRecordKey carries each lookup field's `"GUID;#Label"` value directly), which
   * only surfaces values that appear on at least one already-loaded asset.
   */
  async function fetchLookupOptionsForMeta(meta, signal) {
    if (!meta || !isLookupField(meta)) return [];
    const internalName = String(meta.internalName || "").trim();
    if (!internalName) return [];

    const dataType = getDoubleTapDataTypeForInternalName(internalName);
    if (dataType) {
      const data = await fetchDoubleTapLookupData(signal);
      return buildOptionsFromDoubleTapBucket(data, dataType);
    }

    const rawRows = Object.values(state.rawRowsByRecordKey || {});
    const seen = new Map();
    rawRows.forEach((row) => {
      const merged = mergeRecordFieldValuesIntoRow(row);
      const raw = merged ? merged[internalName] : undefined;
      if (raw == null) return;
      const text = String(raw).trim();
      if (!text) return;
      const sepIndex = text.indexOf(";#");
      if (sepIndex === -1) return;
      const id = text.slice(0, sepIndex).trim();
      const label = text.slice(sepIndex + 2).trim();
      if (!id || !label) return;
      if (!seen.has(id)) seen.set(id, label);
    });
    return Array.from(seen.entries())
      .map(([id, label]) => ({ label, rawValue: `${id};#${label}` }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  function getRecordFieldEntry(record, columnKey) {
    const values = record && Array.isArray(record.RecordFieldValues) ? record.RecordFieldValues : [];
    if (!values.length) return null;
    const internal = normalizeFieldName(getInternalNameForColumnKey(columnKey));
    const display = normalizeFieldName(columnKey);
    for (let i = 0; i < values.length; i += 1) {
      const item = values[i] || {};
      const itemName = normalizeFieldName(item.FieldInternalName);
      if (!itemName) continue;
      if (itemName === internal || itemName === display) return item;
    }
    return null;
  }

  async function loadDynamicColumnsFromView(signal) {
    try {
      await ensureObjectFieldMeta(signal);
      const views = await getAssetViewRows(signal);
      const viewFields = getCachedAssetViewFields();
      const rawRows = Object.values(state.rawRowsByRecordKey || {});
      const rowKeyMap = rawRows.length
        ? buildRowKeyMap(rawRows.map((row) => mergeRecordFieldValuesIntoRow(row)))
        : null;

      state.columnDefs = applyDynamicLabelsToColumns(
        buildColumnsFromViewFields(viewFields.length ? viewFields : parseAssetViewFields((views[0] || {}).ViewFields), rowKeyMap)
      );
    } catch (_error) {
      state.columnDefs = [];
      state.assetViewFields = [];
    }

    const activeKeys = new Set(getActiveFieldList());
    if (
      state.sortState &&
      state.sortState.columnKey &&
      !activeKeys.has(state.sortState.columnKey)
    ) {
      state.sortState = { columnKey: null, columnIndex: null, direction: null };
    }
  }

  async function fetchJson(url, signal) {
    const response = await fetch(url, {
      method: "POST",
      headers: getAuthHeaders(),
      signal
    });
    if (!response.ok) {
      throw new Error(`Request failed (${response.status})`);
    }
    return response.json();
  }

  async function postJson(url, body, signal) {
    const response = await fetch(url, {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify(body || {}),
      signal
    });
    if (!response.ok) {
      throw new Error(`Request failed (${response.status})`);
    }
    const text = await response.text();
    const trimmed = String(text || "").trim();
    if (!trimmed) return "";
    return tryParseJson(trimmed) ?? trimmed.replace(/^"|"$/g, "");
  }

  function isLookupField(meta) {
    if (!meta) return false;
    return ["LUP", "UOG", "TBL", "DD"].includes(String(meta.dataType || "").toUpperCase());
  }

  /**
   * Append a search OR-group after route/status filters using <<NG>> (keeps the base clause intact).
   */
  function combineAssetWhereWithSearch(baseClause, searchOnlyClause) {
    const searchOnly = String(searchOnlyClause || "").trim();
    const base = String(baseClause || "").trim();
    if (!searchOnly) return base;
    if (!base) return searchOnly;
    return `${base}<<NG>>${searchOnly}`;
  }

  function isNumericField(meta) {
    if (!meta) return false;
    return ["DEC", "NUM", "AUN", "INT"].includes(String(meta.dataType || "").toUpperCase());
  }

  function isDateFieldMeta(meta) {
    if (!meta) return false;
    return String(meta.dataType || "").toUpperCase() === "DTE";
  }

  function isCurrencyFieldMeta(meta) {
    return Boolean(meta && meta.isCurrency === true);
  }

  function getStoredCurrencyIcon() {
    function normalizeIcon(value) {
      return String(value == null ? "" : value)
        .trim()
        .replace(/^['"]+|['"]+$/g, "");
    }

    try {
      const direct = window.localStorage && window.localStorage.getItem("CurrencyIcon");
      const directIcon = normalizeIcon(direct);
      if (directIcon) return directIcon;

      const csRaw = window.localStorage && window.localStorage.getItem("CS_SETTING");
      let parsed = tryParseJson(csRaw || "");
      if (typeof parsed === "string") parsed = tryParseJson(parsed);
      const candidates = [];
      if (parsed && typeof parsed === "object") {
        candidates.push(parsed);
        if (typeof parsed.value === "string") {
          const inner = tryParseJson(parsed.value);
          if (inner && typeof inner === "object") candidates.push(inner);
        } else if (parsed.value && typeof parsed.value === "object") {
          candidates.push(parsed.value);
        }
      }
      for (let i = 0; i < candidates.length; i += 1) {
        const icon = normalizeIcon(candidates[i].CurrencyIcon || candidates[i].currencyIcon);
        if (icon) return icon;
      }

      const userRaw = window.localStorage && window.localStorage.getItem("user_key");
      let userParsed = tryParseJson(userRaw || "");
      const userPayload =
        userParsed && typeof userParsed.value === "string"
          ? tryParseJson(userParsed.value)
          : userParsed && userParsed.value && typeof userParsed.value === "object"
            ? userParsed.value
            : userParsed && typeof userParsed === "object"
              ? userParsed
              : null;
      if (userPayload && typeof userPayload === "object") {
        const icon = normalizeIcon(userPayload.CurrencyIcon || userPayload.currencyIcon);
        if (icon) return icon;
      }
    } catch (_error) {
      // Ignore storage access issues.
    }
    return "";
  }

  function formatCurrencyFieldValue(raw, currencyIcon) {
    const text = String(raw == null ? "" : raw).trim();
    if (!text) return "";
    const icon = String(currencyIcon || "").trim();
    const normalized = text.replace(/,/g, "").trim();
    const amount = Number(normalized);
    if (Number.isFinite(amount)) {
      const formattedAmount = amount.toLocaleString("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });
      return icon ? `${icon} ${formattedAmount}` : formattedAmount;
    }
    return icon ? `${icon} ${text}` : text;
  }

  function stripCurrencyDisplayValue(displayValue) {
    const text = String(displayValue || "").trim();
    if (!text) return "";
    const icon = getStoredCurrencyIcon();
    let stripped = text;
    if (icon && stripped.startsWith(icon)) {
      stripped = stripped.slice(icon.length).trim();
    }
    return stripped.replace(/,/g, "").trim();
  }

  function isCellEditable(columnKey, recordKey) {
    if (recordKey) {
      if (!canEditAsset(getPermissionRawRowByRecordKey(recordKey))) return false;
    } else if (isToolbarCreationRestricted()) {
      return false;
    }
    if (SYSTEM_NON_EDITABLE_KEYS.has(columnKey)) return false;
    const meta = getFieldMetaForColumnKey(columnKey);
    if (!meta) return false;
    const normalized = normalizeLooseFieldName(columnKey);
    if (meta.isReadOnly && normalized !== "assetmanager") return false;
    return true;
  }

  /**
   * Resolves the exact key used to read/write this column's value on a raw `api/rnsp` row,
   * mirroring formatRow's own key-resolution order (columnKey first, then the
   * COLUMN_KEY_TO_INTERNAL_NAME remap only as a fallback) so the field name we send to
   * ASSET_TYPE_EASSET_MASTER_DOUBLETAP_UPDATE always matches what we actually read the value
   * from. This matters because that remap table renames a few fields for older display/lookup
   * purposes (e.g. AssetManager -> "Asset Manager") which is NOT the real EAsset_Master column.
   */
  function getEditableFieldNameForColumn(columnKey, rawRow) {
    const internalFromMap = getInternalNameForColumnKey(columnKey);
    const candidates = [columnKey, internalFromMap !== columnKey ? internalFromMap : ""].filter(Boolean);
    for (let i = 0; i < candidates.length; i += 1) {
      if (rawRow && Object.prototype.hasOwnProperty.call(rawRow, candidates[i])) return candidates[i];
    }
    return columnKey;
  }

  /** Saves one field via `api/rnsp` (ASSET_TYPE_EASSET_MASTER_DOUBLETAP_UPDATE) instead of api/UpdateRecord. */
  async function updateEAssetMasterField(recordID, fieldName, fieldValue, signal) {
    const payload = {
      Name: EASSET_MASTER_UPDATE_RNSP_NAME,
      Args: {
        RecordID: String(recordID || ""),
        FieldName: String(fieldName || ""),
        FieldValue: fieldValue == null ? "" : String(fieldValue)
      }
    };
    const result = await postJson(`${getAppApiBase()}/api/rnsp`, payload, signal);
    const ok =
      result === true ||
      String(result).trim().toLowerCase() === "true" ||
      (result && typeof result === "object" && (result.Success === true || result.success === true));
    if (!ok) {
      throw new Error("Record update failed.");
    }
  }

  /**
   * After a successful save, patch state locally instead of doing a full reload: re-checks the
   * edited row against the current Category/Type/status/search filters (using the value we just
   * saved) and either removes it from view (it no longer belongs on this filtered page) or
   * refreshes its displayed row in place - then re-renders from local state only, no network call.
   */
  function applyLocalRowUpdateAfterSave(recordKey, rawRow) {
    const effectiveStatus = state.selectedStatus === "GrossTotal" ? "" : state.selectedStatus;
    const stillMatches = rawRow && filterAssetRowsForRoute([rawRow], effectiveStatus).length > 0;
    if (!stillMatches) {
      delete state.rawRowsByRecordKey[recordKey];
      state.apiRows = state.apiRows.filter((row) => row.__recordKey !== recordKey);
    } else {
      const formatted = formatRow(rawRow, state.employeesMap);
      const idx = state.apiRows.findIndex((row) => row.__recordKey === recordKey);
      if (idx !== -1) {
        state.apiRows[idx] = formatted;
      } else {
        state.apiRows.push(formatted);
      }
    }
    rebuildAllRows();
  }

  function updateFormattedRowsAfterSave(recordKey, columnKey, nextDisplayValue, nextSortValue) {
    const targetRecordId = getRecordIdFromRecordKey(recordKey);
    const patchRow = (row) => {
      if (!row) return row;
      const sameKey = row.__recordKey === recordKey;
      const sameId =
        Boolean(targetRecordId) && String(row.__recordID || "").trim() === targetRecordId;
      if (!sameKey && !sameId) return row;
      const patched = { ...row };
      patched[columnKey] = nextDisplayValue;
      patched.__sortValues = { ...(row.__sortValues || {}), [columnKey]: nextSortValue };
      return patched;
    };
    state.apiRows = state.apiRows.map(patchRow);
    state.localRows = state.localRows.map(patchRow);
    rebuildAllRows();
  }

  function getLookupLabelToRawValueMap(columnKey) {
    const map = {};
    const addRawValue = (raw) => {
      const text = String(raw || "").trim();
      if (!text) return;
      const label = parseLookupLabel(text);
      if (!label) return;
      if (!map[label]) map[label] = text;
    };
    Object.values(state.rawRowsByRecordKey || {}).forEach((record) => {
      const entry = getRecordFieldEntry(record, columnKey);
      if (!entry) return;
      addRawValue(entry.FieldValue);
      addRawValue(entry.UGFieldValue);
      addRawValue(entry.UGFfieldValue);
    });
    return map;
  }

  function setBusy(isBusy) {
    if (!ui.main) return;
    ui.main.setAttribute("aria-busy", String(isBusy));
  }

  function showError(message) {
    if (!ui.errorBox) return;
    ui.errorBox.hidden = false;
    ui.errorBox.textContent = message;
  }

  function clearError() {
    if (!ui.errorBox) return;
    ui.errorBox.hidden = true;
    ui.errorBox.textContent = "";
  }

  function applyCsSettingButtonTheme() {
    if (window.QafLibrary && typeof window.QafLibrary.applyCsSettingTheme === "function") {
      window.QafLibrary.applyCsSettingTheme("#assetDetailsAppHost");
    }
  }

  function showLoadMoreHint(message) {
    if (!ui.loadMoreHint) return;
    ui.loadMoreHint.hidden = false;
    ui.loadMoreHint.textContent = message;
    ui.loadMoreHint.setAttribute("role", "status");
  }

  function clearLoadMoreHint() {
    if (!ui.loadMoreHint) return;
    ui.loadMoreHint.hidden = true;
    ui.loadMoreHint.textContent = "";
  }

  function canTriggerAssetTableLazyLoad() {
    return !shouldHardBlockAssetFetch() && !state.assetsLoading && state.assetsHasMore;
  }

  /*
   * Infinite scroll for the grid.
   *
   * Both halves of this live in library.js and are used from here rather than
   * reimplemented: createScrollableTable() pins the wrap to its own scrolling
   * viewport and hands back that scroller, createContainerScrollHandler() binds
   * the passive near-bottom watcher, and isContainerNearBottom() is the test
   * itself. Each lookup is optional - a build of library.js that does not expose
   * a given function falls through to the plain listener / arithmetic below, so
   * the grid pages either way.
   */
  const TABLE_VIEWPORT_HEIGHT_PX = 480;
  const LOAD_MORE_OFFSET_PX = 80;

  function getLibraryFn(name) {
    return window.QafLibrary && typeof window.QafLibrary[name] === "function"
      ? window.QafLibrary[name]
      : null;
  }

  // Pins #tableWrap to a 480px scroller. minHeight === maxHeight so the helper
  // resolves to exactly 480 instead of measuring the viewport; the same 480 is
  // declared in asset-details.css for builds without this helper.
  function ensureScrollableTable() {
    // Drop a handle whose wrap was replaced by a re-mount, so the next call
    // sizes and watches the live one.
    if (scrollableTable && scrollableTable.container && !scrollableTable.container.isConnected) {
      scrollableTable = null;
      lazyLoadScrollHandler = null;
      lazyLoadScrollBound = false;
    }
    if (scrollableTable) return scrollableTable;
    const container = ui.tableWrap || document.getElementById("tableWrap");
    if (!container) return null;
    const createScrollableTable = getLibraryFn("createScrollableTable");
    if (!createScrollableTable) return null;
    try {
      scrollableTable = createScrollableTable({
        container: container,
        table: ui.tableElement || document.getElementById("assetTable"),
        minHeight: TABLE_VIEWPORT_HEIGHT_PX,
        maxHeight: TABLE_VIEWPORT_HEIGHT_PX
      });
    } catch (_) {
      scrollableTable = null;
    }
    return scrollableTable;
  }

  function isAssetTableScrollNearBottom(container, offsetPx) {
    const offset = Number(offsetPx);
    const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : LOAD_MORE_OFFSET_PX;
    const isContainerNearBottom = getLibraryFn("isContainerNearBottom");
    if (isContainerNearBottom) return isContainerNearBottom(container, safeOffset);
    const el = container;
    if (!el || el === window || el === document || el === document.documentElement) {
      return false;
    }
    const scrollTop = el.scrollTop || 0;
    const clientHeight = el.clientHeight || 0;
    const scrollHeight = el.scrollHeight || 0;
    if (scrollHeight <= clientHeight + 1) return false;
    return scrollTop + clientHeight >= scrollHeight - safeOffset;
  }

  function onAssetTableNearBottom() {
    if (!canTriggerAssetTableLazyLoad()) return;
    const container = getTableScrollContainer();
    if (!isAssetTableScrollNearBottom(container, LOAD_MORE_OFFSET_PX)) return;
    loadNextPage();
  }

  function getTableScrollContainer() {
    if (scrollableTable && typeof scrollableTable.getScrollContainer === "function") {
      return scrollableTable.getScrollContainer();
    }
    return ui.tableWrap || document.getElementById("tableWrap") || null;
  }

  // A first page shorter than the 480px viewport leaves nothing to scroll, so
  // top up until the grid actually overflows and the watcher can take over.
  function ensureAssetTableCanLazyLoad() {
    if (!canTriggerAssetTableLazyLoad()) return;
    const container = getTableScrollContainer();
    if (!container || container === window || container === document) return;
    const scrollHeight = container.scrollHeight || 0;
    const clientHeight = container.clientHeight || 0;
    if (scrollHeight > clientHeight + 1) return;
    void loadNextPage();
  }

  function notifyAssetTableScrollLayout() {
    if (scrollableTable && typeof scrollableTable.refresh === "function") {
      scrollableTable.refresh();
    }
    ensureAssetTableCanLazyLoad();
    // Re-test after a body re-render: the pointer can already be resting past
    // the trigger line, with no further scroll event coming.
    if (lazyLoadScrollHandler && typeof lazyLoadScrollHandler.check === "function") {
      lazyLoadScrollHandler.check();
    }
  }

  // Page more rows in as the user reaches the end of the grid's own scroller.
  function setupTableLazyLoading() {
    ensureScrollableTable();
    const container = getTableScrollContainer();
    if (!container || lazyLoadScrollBound) return;
    const createContainerScrollHandler = getLibraryFn("createContainerScrollHandler");
    if (createContainerScrollHandler) {
      lazyLoadScrollHandler = createContainerScrollHandler({
        container: container,
        offsetPx: LOAD_MORE_OFFSET_PX,
        canTrigger: canTriggerAssetTableLazyLoad,
        onNearBottom: function () {
          void loadNextPage();
        }
      });
      lazyLoadScrollHandler.connect();
    } else {
      container.addEventListener("scroll", onAssetTableNearBottom, { passive: true });
    }
    lazyLoadScrollBound = true;
  }

  function buildStatusCards() {
    const cards = state.statusSummary;
    const titleMarkup = '<h2 id="summaryHeading" class="status-cards__title">Summary</h2>';
    if (!cards.length) {
      ui.statusCards.innerHTML = titleMarkup;
      return;
    }
    ui.statusCards.innerHTML =
      titleMarkup +
      cards
      .map((item) => {
        const rawStatus = String(item.ItemStatus || "Unknown");
        const displayStatus = rawStatus === "GrossTotal" ? "Total" : rawStatus;
        const label = escapeHtml(displayStatus);
        const total = String(Number(item.TotalNumber || 0));
        const isActive =
          !!state.selectedStatus &&
          normalizeStatusToken(rawStatus) === normalizeStatusToken(state.selectedStatus);
        return `<button class="status-card${isActive ? " status-card--active" : ""}" data-status="${escapeHtml(rawStatus)}" type="button"><div class="status-card__line"><span class="status-card__name">${label}</span><span class="status-card__count">${total}</span></div></button>`;
      })
      .join("");
  }

  /** True when `arr` already looks like the flat `[{ItemStatus, TotalNumber}, ...]` summary shape. */
  function looksLikeStatusSummaryArray(value) {
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every(
        (item) =>
          item &&
          typeof item === "object" &&
          ("ItemStatus" in item || "itemstatus" in item || "TotalNumber" in item || "totalnumber" in item)
      )
    );
  }

  /** Case-insensitive lookup of a `StatusWithNumber`-style key on an object. */
  function readStatusWithNumberKey(obj) {
    if (!obj || typeof obj !== "object") return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, "StatusWithNumber")) return obj.StatusWithNumber;
    const matchKey = Object.keys(obj).find((k) => normalizeLooseFieldName(k) === "statuswithnumber");
    return matchKey ? obj[matchKey] : undefined;
  }

  /**
   * The item-status summary now comes from `api/rnsp` (`ASSET_TYPE_ITEMSTATUS_FILTER`) as a flat
   * array of `{ItemStatus, TotalNumber}` rows, handled directly by `looksLikeStatusSummaryArray`
   * below. This unwrapping is kept for resilience against a nested/legacy shape where a
   * `StatusWithNumber` collection comes back JSON-encoded as a *string* rather than a real array
   * (a SQL Server `FOR JSON` quirk) so a differently-shaped response still surfaces its data
   * instead of leaving the summary cards empty.
   */
  function coerceStatusWithNumberValue(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = tryParseJson(value.trim());
      if (Array.isArray(parsed)) return parsed;
    }
    return null;
  }

  function extractStatusWithNumber(payload) {
    if (payload == null) return [];
    if (typeof payload === "string") {
      const parsed = tryParseJson(payload.trim());
      return parsed != null ? extractStatusWithNumber(parsed) : [];
    }
    if (looksLikeStatusSummaryArray(payload)) return payload;
    if (Array.isArray(payload)) {
      for (let i = 0; i < payload.length; i += 1) {
        const candidate = coerceStatusWithNumberValue(readStatusWithNumberKey(payload[i]));
        if (candidate) return candidate;
      }
      for (let i = 0; i < payload.length; i += 1) {
        const nested = extractStatusWithNumber(payload[i]);
        if (nested.length) return nested;
      }
      return [];
    }
    if (typeof payload === "object") {
      const direct = coerceStatusWithNumberValue(readStatusWithNumberKey(payload));
      if (direct) return direct;
      const rows = normalizeRecords(payload);
      for (let i = 0; i < rows.length; i += 1) {
        const candidate = coerceStatusWithNumberValue(readStatusWithNumberKey(rows[i]));
        if (candidate) return candidate;
      }
    }
    return [];
  }

  function normalizeStatusSummary(items) {
    const order = [];
    const totals = new Map();
    (Array.isArray(items) ? items : []).forEach((item) => {
      const itemStatus = String(item && item.ItemStatus ? item.ItemStatus : "").trim();
      if (!itemStatus) return;
      const totalNumber = Number(item && item.TotalNumber);
      const nextTotal = Number.isFinite(totalNumber) ? totalNumber : 0;
      if (!totals.has(itemStatus)) order.push(itemStatus);
      totals.set(itemStatus, (totals.get(itemStatus) || 0) + nextTotal);
    });
    return order.map((itemStatus) => ({
      ItemStatus: itemStatus,
      TotalNumber: totals.get(itemStatus)
    }));
  }

  function columnMatchesAssignedTo(column) {
    if (!column) return false;
    const keys = [column.key, column.internalName, column.displayName]
      .map((k) => normalizeLooseFieldName(k))
      .filter(Boolean);
    return keys.some((k) => k === "assignedto");
  }

  function columnMatchesAssetManager(column) {
    if (!column) return false;
    const keys = [column.key, column.internalName, column.displayName]
      .map((k) => normalizeLooseFieldName(k))
      .filter(Boolean);
    return keys.some((k) => k === "assetmanager");
  }

  function formatRow(row, employeesMap) {
    const mapped = {};
    const sortValues = {};
    getActiveColumnDefs().forEach((column) => {
      const columnKey = column && column.key;
      const internalFromMap = columnKey ? getInternalNameForColumnKey(columnKey) : "";
      const possibleKeys = [
        columnKey,
        internalFromMap && internalFromMap !== columnKey ? internalFromMap : "",
        column && column.internalName,
        column && column.displayName
      ].filter(Boolean);
      const seenKeys = new Set();
      const uniquePossibleKeys = possibleKeys.filter((k) => {
        if (!k || seenKeys.has(k)) return false;
        seenKeys.add(k);
        return true;
      });
      let rawValue = "";
      for (let i = 0; i < uniquePossibleKeys.length; i += 1) {
        rawValue = resolveFieldValue(row, uniquePossibleKeys[i]);
        if (rawValue != null && String(rawValue).trim() !== "") break;
      }
      if (columnMatchesAssignedTo(column)) {
        const ids = parseAssignedRecordIds(rawValue);
        if (ids.length) {
          mapped[column.key] = ids.map((id) => employeesMap[id] || id).join(", ");
          sortValues[column.key] = mapped[column.key];
          return;
        }
      }
      if (columnMatchesAssetManager(column)) {
        const ids = collectAssetManagerIds(row);
        if (ids.length) {
          mapped[column.key] = ids.map((id) => employeesMap[id] || id).join(", ");
          sortValues[column.key] = mapped[column.key];
          return;
        }
      }
      const normalized = normalizeAnyValue(rawValue);
      if (column.isCurrency) {
        sortValues[column.key] = normalized;
        mapped[column.key] = formatCurrencyFieldValue(normalized, getStoredCurrencyIcon());
        return;
      }
      sortValues[column.key] = column.isDate ? rawValue : normalized;
      mapped[column.key] = column.isDate
        ? formatTableDateValue(normalized, {
            meta: getFieldMetaForColumnKey(column.key),
            dateOnly: column.key === "Created Date" || column.isDateOnly === true,
            isDateTime: column.isDateTime === true,
            forceUtc: true
          })
        : normalized;
    });
    mapped.__sortValues = sortValues;
    mapped.__recordKey = getRecordKeyFromRow(row);
    mapped.__recordID = getRecordIDFromRow(row);
    mapped.__itemStatus = String(
      resolveFieldValue(row, "ItemStatus") || row.ItemStatus || ""
    ).trim();
    return mapped;
  }

  function getColumnMinWidth(column) {
    if (!column) return MIN_COLUMN_WIDTH;
    let baseMinWidth = MIN_COLUMN_WIDTH;
    const looseKey = normalizeLooseFieldName(column.key);
    if (looseKey === "type") baseMinWidth = 130;
    if (looseKey === "assetname") baseMinWidth = 150;
    if (looseKey === "serialnumber" || looseKey === "serialno") baseMinWidth = 125;
    if (column.isBadge) baseMinWidth = 125;
    if (column.isDate) baseMinWidth = 130;
    if (column.isCurrency) baseMinWidth = 120;

    const headerFitWidth = estimateWidthForText(column.label) + 40;
    return Math.max(baseMinWidth, headerFitWidth);
  }

  function estimateWidthForText(text) {
    const length = String(text || "").length;
    return Math.round(length * 8 + 26);
  }

  function getContentBasedColumnWidth(column) {
    const sampleRows = state.filteredRows.slice(0, 50);
    const widthSamples = [estimateWidthForText(column.label)];
    for (let i = 0; i < sampleRows.length; i += 1) {
      const row = sampleRows[i];
      const value = row && row[column.key] != null ? String(row[column.key]) : "";
      widthSamples.push(estimateWidthForText(value));
    }
    widthSamples.sort((a, b) => a - b);
    const percentileIndex = Math.min(
      widthSamples.length - 1,
      Math.max(0, Math.floor(widthSamples.length * 0.9))
    );
    const contentWidth = widthSamples[percentileIndex];
    const minWidth = getColumnMinWidth(column);
    const cap = column.isBadge ? 180 : MAX_COLUMN_WIDTH;
    return Math.max(minWidth, Math.min(cap, contentWidth));
  }

  function ensureColumnWidths() {
    const activeColumns = getActiveColumnDefs();
    if (!Array.isArray(state.columnWidths) || state.columnWidths.length !== activeColumns.length) {
      state.columnWidths = activeColumns.map((column) => getContentBasedColumnWidth(column));
    }
  }

  // Recompute the content-based defaults. Columns the user has dragged are not
  // special-cased here: GridTable ranks its own saved width above a declared
  // default, so a dragged column keeps the user's width either way.
  function autoFitColumnWidthsFromContent() {
    ensureColumnWidths();
    getActiveColumnDefs().forEach((column, index) => {
      state.columnWidths[index] = getContentBasedColumnWidth(column);
    });
    syncColumnWidths();
  }

  function resetColumnWidthsForFreshData() {
    state.columnWidths = getActiveColumnDefs().map((column) => getContentBasedColumnWidth(column));
    syncColumnWidths();
  }

  function getAppliedColumnWidth(width, index) {
    const activeColumns = getActiveColumnDefs();
    const column = activeColumns[index] || activeColumns[0];
    const minWidth = getColumnMinWidth(column);
    return Math.max(minWidth, Number(width) || minWidth);
  }

  /*
   * Column sizing and resizing are delegated to GridTable (library.js), which is
   * the single engine allowed to write <colgroup> - the page computing widths and
   * also writing cols itself is what used to let two sizing systems fight over
   * the same table. This page still decides the *default* widths (content-based,
   * per field type) and hands them over as `columnWidths`; GridTable applies
   * them, injects the .gt-col-resizer handles with their pipe separator, draws
   * the .gt-resize-line while dragging, and persists the user's widths.
   */
  function getGridTableApi() {
    const api = window.GridTable;
    return api && typeof api.create === "function" ? api : null;
  }

  function getDeclaredColumnWidths() {
    ensureColumnWidths();
    return [
      ROW_ACTIONS_COLUMN_WIDTH,
      ...state.columnWidths.map((width, index) => getAppliedColumnWidth(width, index))
    ];
  }

  function getDeclaredColumnMinWidths() {
    return [
      ROW_ACTIONS_COLUMN_WIDTH,
      ...getActiveColumnDefs().map((column) => getColumnMinWidth(column))
    ];
  }

  // Re-point the instance at the freshly rendered header row, then re-apply the
  // widths. Called after every head render, since GridTable caches its handles.
  function syncColumnWidths() {
    const table = ui.tableElement || document.getElementById("assetTable");
    const api = getGridTableApi();
    if (!table || !api) return;

    const options = {
      sortable: false, // this page sorts through the API, not by reordering DOM rows
      resizable: true,
      minWidth: MIN_COLUMN_WIDTH,
      maxWidth: MAX_COLUMN_WIDTH,
      columnWidths: getDeclaredColumnWidths(),
      columnMinWidths: getDeclaredColumnMinWidths(),
      resizeStorageKey: COLUMN_RESIZE_STORAGE_KEY
    };

    // create() returns the cached instance for a table, so the old one has to go
    // before a rebuilt header row can get fresh handles.
    if (gridTable) gridTable.destroy();
    gridTable = api.create(table, options);
  }

  const SORT_ICON_NEUTRAL = "\u2195";
  const SORT_ICON_ASC = "\u2191";
  const SORT_ICON_DESC = "\u2193";

  function getSortIconText(columnKey, activeKey, activeDirection) {
    if (activeKey !== columnKey || !activeDirection) return SORT_ICON_NEUTRAL;
    return activeDirection === "asc" ? SORT_ICON_ASC : SORT_ICON_DESC;
  }

  // The resize handle is not written here: GridTable (library.js) injects its own
  // .gt-col-resizer into every header that is not marked .no-resize, and owns the
  // <colgroup> from then on. syncColumnWidths() below re-attaches it after each
  // head re-render.
  function renderTableHead() {
    const activeKey = state.sortState && state.sortState.direction ? state.sortState.columnKey : null;
    const activeDirection = state.sortState ? state.sortState.direction : null;
    const headCells = getActiveColumnDefs()
      .map((column, index) => {
        const isSorted = activeKey === column.key && !!activeDirection;
        const sortIconText = getSortIconText(column.key, activeKey, activeDirection);
        const thAssetNameClass = isAssetNameColumn(column) ? " asset-name-col" : "";
        const thSortedClass = isSorted ? " is-sorted" : "";
        return `<th class="is-sortable${thSortedClass}${thAssetNameClass}" data-sort-index="${index}" data-sort-key="${escapeHtml(column.key)}"${isSorted ? ` aria-sort="${activeDirection === "asc" ? "ascending" : "descending"}"` : ' aria-sort="none"'}><span class="th-label">${escapeHtml(column.label)}</span><span class="th-sort-icon" aria-hidden="true">${sortIconText}</span></th>`;
      })
      .join("");
    ui.tableHeadRow.innerHTML = `<th class="row-actions-head no-sort no-resize" aria-label="Actions"></th>${headCells}`;
    syncColumnWidths();
  }

  function getRowActionItems(row) {
    const rawRow = getPermissionRawRow(row);
    const items = [{ key: "view", label: "View", icon: "fa fa-eye" }];
    if (canEditAsset(rawRow)) {
      items.push({ key: "edit", label: "Edit", icon: "fa fa-pencil" });
    }
    const token = normalizeStatusToken(row && row.ItemStatus);
    if (canAssignOrDeallocateAsset(rawRow)) {
      if (token === "allocated") {
        items.push({ key: "deallocate", label: "Deallocate", icon: "fa fa-chain-broken" });
      } else if (token !== "inrepair" && token !== "inrepairvendor") {
        items.push({ key: "allocate", label: "Allocate", icon: "fa fa-link" });
      }
    }
    if (canDeleteAsset(rawRow)) {
      items.push({ key: "delete", label: "Delete", icon: "fa fa-trash-o" });
    }
    return items;
  }

  function getRecordIdFromRecordKey(recordKey) {
    const text = String(recordKey || "");
    const prefixes = ["RecordID:", "RecordId:", "recordID:", "recordid:", "ID:", "Id:"];
    for (let i = 0; i < prefixes.length; i += 1) {
      const prefix = prefixes[i];
      if (text.startsWith(prefix)) {
        return text.slice(prefix.length).trim();
      }
    }
    return "";
  }

  function isRowActionMenuOpen() {
    return Boolean(state.activeRowMenuRecordKey);
  }

  function hideOpenRowActionMenu() {
    if (!state.activeRowMenuRecordKey) return;
    state.activeRowMenuRecordKey = null;
    if (!ui.tableBody) return;
    const menu = ui.tableBody.querySelector(".row-actions__menu.is-open");
    if (!menu) return;
    menu.hidden = true;
    menu.classList.remove("is-open", "row-actions__menu--up", "row-actions__menu--align-right");
    menu.style.top = "";
    menu.style.left = "";
  }

  function bindRowMenuScrollDismiss() {
    if (rowMenuScrollDismissBound) return;
    rowMenuScrollDismissBound = true;

    function dismissRowMenuOnScroll() {
      if (!isRowActionMenuOpen()) return;
      hideOpenRowActionMenu();
    }

    window.addEventListener("scroll", dismissRowMenuOnScroll, { passive: true });
    document.addEventListener("wheel", dismissRowMenuOnScroll, { passive: true });
    document.addEventListener("touchmove", dismissRowMenuOnScroll, { passive: true });

    const scrollContainer = ui.tableWrap || document.getElementById("tableWrap");
    if (scrollContainer) {
      scrollContainer.addEventListener("scroll", dismissRowMenuOnScroll, { passive: true });
    }
  }

  function closeRowActionMenu() {
    if (!state.activeRowMenuRecordKey) return;
    state.activeRowMenuRecordKey = null;
    renderTable();
  }

  async function openRecordFormByMode(mode, recordID) {
    const viewID = await getAssetViewId();
    const objectID = await getMasterObjectId();
    const params = new URLSearchParams({
      objectID,
      viewID,
      recordID,
      mode,
      drMode: "false"
    });
    window.location.assign(`${window.location.origin}/workflow-engine/i-form?${params.toString()}`);
  }

  function tryExecuteQafRecordAction(actionKey, recordID, onDone) {
    const services = [window.QafPageService, window.parent && window.parent.QafPageService].filter(Boolean);
    const repositoryName = "EAsset Master";
    const callback = typeof onDone === "function" ? onDone : undefined;
    const definitions = {
      view: {
        methods: ["ViewItem"],
        args: [
          [repositoryName, recordID, callback],
          [repositoryName, recordID],
          [getMasterObjectIdSync(), recordID, callback],
          [getMasterObjectIdSync(), recordID],
          [recordID, callback],
          [recordID]
        ]
      },
      edit: {
        methods: ["EditItem"],
        args: [
          [repositoryName, recordID, callback],
          [repositoryName, recordID],
          [getMasterObjectIdSync(), recordID, callback],
          [getMasterObjectIdSync(), recordID],
          [recordID, callback],
          [recordID]
        ]
      },
      delete: {
        methods: ["DeleteItem"],
        args: [
          [recordID, callback],
          [recordID],
          [repositoryName, recordID, callback],
          [repositoryName, recordID]
        ]
      }
    };
    const definition = definitions[actionKey];
    if (!definition) return false;
    for (let i = 0; i < services.length; i += 1) {
      const service = services[i];
      for (let m = 0; m < definition.methods.length; m += 1) {
        const fn = service && service[definition.methods[m]];
        if (typeof fn !== "function") continue;
        for (let a = 0; a < definition.args.length; a += 1) {
          try {
            fn.apply(service, definition.args[a]);
            return true;
          } catch (_error) {
            // Try next signature.
          }
        }
      }
    }
    return false;
  }

  function tryExecuteBundleGridAction(actionKey, recordID) {
    const service = getQafPageService();
    if (!service || !recordID) return false;
    syncBundleEnvUrl();
    const onDone = () => {
      loadDataAfterSave();
    };
    try {
      if (actionKey === "view" && typeof service.ViewItem === "function") {
        service.ViewItem(MASTER_LIST_OBJECT_NAME, recordID, onDone);
        return true;
      }
      if (actionKey === "edit" && typeof service.EditItem === "function") {
        service.EditItem(MASTER_LIST_OBJECT_NAME, recordID, onDone);
        return true;
      }
      if (actionKey === "delete" && typeof service.DeleteItem === "function") {
        service.DeleteItem(recordID, onDone);
        return true;
      }
    } catch (_error) {
      // Fall through to existing fallback logic below.
    }
    return false;
  }

  async function handleRowAction(actionKey, recordKey) {
    closeRowActionMenu();
    const row = state.filteredRows.find((item) => item && item.__recordKey === recordKey);
    const recordID = String((row && row.__recordID) || getRecordIdFromRecordKey(recordKey) || "").trim();
    if (!row || !recordID) {
      showError("Unable to resolve selected record.");
      return;
    }
    const rawRow = getPermissionRawRow(row);
    if (actionKey === "allocate") {
      if (!canAssignOrDeallocateAsset(rawRow)) return;
      try {
        await openAllocationForm(recordKey, row, recordID);
      } catch (error) {
        const message = error && error.message ? String(error.message) : "Unable to open allocation form.";
        showError(message);
      }
      return;
    }
    if (actionKey === "deallocate") {
      if (!canAssignOrDeallocateAsset(rawRow)) return;
      try {
        await openDeallocationForm(recordKey, row, recordID);
      } catch (error) {
        const message = error && error.message ? String(error.message) : "Unable to open deallocation form.";
        showError(message);
      }
      return;
    }
    if (actionKey === "view") {
      if (tryExecuteBundleGridAction(actionKey, recordID)) return;
      await openMasterViewForm(recordID);
      return;
    }
    if (actionKey === "edit") {
      if (!canEditAsset(rawRow)) return;
      if (tryExecuteBundleGridAction(actionKey, recordID)) return;
      await openMasterEditForm(recordID);
      return;
    }
    if (actionKey === "delete") {
      if (!canDeleteAsset(rawRow)) return;
      if (tryExecuteBundleGridAction(actionKey, recordID)) return;
      const handled = tryExecuteQafRecordAction(actionKey, recordID, () => {
        if (actionKey === "delete") {
          loadData();
        }
      });
      if (handled) return;
      showError("Delete action is unavailable in this context.");
    }
  }

  function renderTable() {
    if (state.activeEditCell) {
      state.activeEditCell = null;
    }
    const rows = state.filteredRows;
    const activeColumns = getActiveColumnDefs();
    if (!rows.length) {
      if (!state.hasLoadedOnce) {
        ui.tableBody.innerHTML = `<tr><td colspan="${activeColumns.length + 1}">Loading records...</td></tr>`;
        ui.resultCount.textContent = "0";
        return;
      }
      ui.tableBody.innerHTML = `<tr><td colspan="${activeColumns.length + 1}">No records found.</td></tr>`;
    } else {
      ui.tableBody.innerHTML = rows
        .map((row) => {
          const recordKey = escapeHtml(row.__recordKey || "");
          const isMenuOpen = state.activeRowMenuRecordKey === (row.__recordKey || "");
          const actionItems = getRowActionItems(row);
          const actionCell = `
            <td class="row-actions" data-record-key="${recordKey}">
              <button class="row-actions__toggle" type="button" aria-label="Open actions" data-row-menu-toggle data-record-key="${recordKey}">
                <i class="fa fa-ellipsis-v" aria-hidden="true"></i>
              </button>
              <div class="row-actions__menu${isMenuOpen ? " is-open" : ""}" ${isMenuOpen ? "" : "hidden"}>
                ${actionItems
                  .map(
                    (item) =>
                      `<button type="button" class="row-actions__item" data-row-action="${escapeHtml(
                        item.key
                      )}" data-record-key="${recordKey}"><i class="${escapeHtml(item.icon)}" aria-hidden="true"></i><span>${escapeHtml(
                        item.label
                      )}</span></button>`
                  )
                  .join("")}
              </div>
            </td>`;
          const cells = activeColumns.map((column) => {
            const value = row[column.key] || "";
            const editable = isCellEditable(column.key, row.__recordKey) ? "true" : "false";
            const tdClassAttr = isAssetNameColumn(column) ? ' class="asset-name-col"' : "";
            if (column.isBadge) {
              const badgeText = value || "Unknown";
              const statusClass = `badge--${toStatusClassName(badgeText)}`;
              return `<td${tdClassAttr} data-column-key="${escapeHtml(column.key)}" data-record-key="${recordKey}" data-editable="${editable}"><span class="badge ${statusClass}">${escapeHtml(badgeText)}</span></td>`;
            }
            if (isSerialNumberColumn(column)) {
              const serialText = escapeHtml(value);
              const serialHref = escapeHtml(buildSerialDetailsPageUrl(row));
              return `<td${tdClassAttr} data-column-key="${escapeHtml(column.key)}" data-record-key="${recordKey}" data-editable="false"><a href="${serialHref}" class="serial-link" data-row-view-link="true" data-record-key="${recordKey}">${serialText}</a></td>`;
            }
            return `<td${tdClassAttr} data-column-key="${escapeHtml(column.key)}" data-record-key="${recordKey}" data-editable="${editable}">${escapeHtml(value)}</td>`;
          }).join("");
          return `<tr data-record-key="${recordKey}">${actionCell}${cells}</tr>`;
        })
        .join("");
    }

    const activeStatusLabel = getActiveStatusDisplayLabel();
    if (ui.resultMeta) {
      ui.resultMeta.hidden = !activeStatusLabel;
    }
    if (ui.resultCount) {
      ui.resultCount.textContent = activeStatusLabel ? String(getResultCountValue()) : "";
    }
    if (ui.resultScope) {
      ui.resultScope.textContent = activeStatusLabel ? `records ${activeStatusLabel}` : "";
    }
    requestAnimationFrame(positionOpenRowActionMenu);
  }

  function positionOpenRowActionMenu() {
    if (!ui.tableBody) return;
    const menu = ui.tableBody.querySelector(".row-actions__menu.is-open");
    if (!menu) return;
    menu.classList.remove("row-actions__menu--up", "row-actions__menu--align-right");
    const toggle = menu.previousElementSibling;
    if (!toggle || typeof toggle.getBoundingClientRect !== "function") return;

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const toggleRect = toggle.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const menuWidth = Math.max(menuRect.width || 0, 126);
    const menuHeight = menuRect.height || 0;
    const margin = 8;

    let top = toggleRect.bottom - 6;
    let left = toggleRect.left + 4;

    if (top + menuHeight > viewportHeight - margin) {
      top = toggleRect.top - menuHeight + 6;
    }
    if (left + menuWidth > viewportWidth - margin) {
      left = toggleRect.right - menuWidth - 4;
    }

    top = Math.max(margin, top);
    left = Math.max(margin, left);

    menu.style.top = `${Math.round(top)}px`;
    menu.style.left = `${Math.round(left)}px`;
  }

  function getResultCountValue() {
    const summary = Array.isArray(state.statusSummary) ? state.statusSummary : [];
    if (!summary.length) return state.filteredRows.length;

    const targetStatus = state.selectedStatus ? String(state.selectedStatus) : "GrossTotal";
    const matched = summary.find(
      (item) =>
        normalizeStatusToken(String(item && item.ItemStatus ? item.ItemStatus : "")) ===
        normalizeStatusToken(targetStatus)
    );
    if (matched && Number.isFinite(Number(matched.TotalNumber))) {
      return Number(matched.TotalNumber);
    }
    return state.filteredRows.length;
  }

  function getActiveStatusDisplayLabel() {
    if (!state.selectedStatus) return "";
    const status = String(state.selectedStatus);
    return status === "GrossTotal" ? "Total" : status;
  }

  function matchesSelectedStatus(row) {
    if (!state.selectedStatus || state.selectedStatus === "GrossTotal") return true;
    const statusText = String(
      (row && row.__itemStatus) ||
        (row && row.ItemStatus) ||
        getRowItemStatus(row) ||
        ""
    ).trim();
    return statusMatches({ ItemStatus: statusText }, state.selectedStatus);
  }

  function rebuildAllRows() {
    hideOpenRowActionMenu();
    state.allRows = [...state.localRows, ...state.apiRows];
    state.filteredRows = getSortedRows(state.allRows.filter((row) => matchesSelectedStatus(row)));
    autoFitColumnWidthsFromContent();
    renderTable();
    notifyAssetTableScrollLayout();
  }

  function parseSortDateValue(value) {
    if (value == null || value === "") return null;
    if (value instanceof Date) {
      const time = value.getTime();
      return Number.isNaN(time) ? null : time;
    }
    const parsed = tryParseUtcDateValue(value);
    if (parsed) return parsed.getTime();
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? null : time;
  }

  function parseNumericSortValue(value) {
    if (value == null || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const text = String(value).trim();
    if (!text) return null;
    const normalized = text.replace(/,/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
    const num = Number(normalized);
    return Number.isFinite(num) ? num : null;
  }

  function compareValuesForSort(aValue, bValue, column) {
    if (column && column.isDate) {
      const aDate = parseSortDateValue(aValue);
      const bDate = parseSortDateValue(bValue);
      if (aDate != null && bDate != null) return aDate - bDate;
      if (aDate != null) return 1;
      if (bDate != null) return -1;
    }

    if (column && column.isCurrency) {
      const aNumeric = parseNumericSortValue(aValue);
      const bNumeric = parseNumericSortValue(bValue);
      if (aNumeric != null && bNumeric != null) return aNumeric - bNumeric;
      if (aNumeric != null) return 1;
      if (bNumeric != null) return -1;
    }

    const aNumeric = parseNumericSortValue(aValue);
    const bNumeric = parseNumericSortValue(bValue);
    if (aNumeric != null && bNumeric != null) {
      return aNumeric - bNumeric;
    }

    const aText = String(aValue ?? "").toLowerCase();
    const bText = String(bValue ?? "").toLowerCase();
    return aText.localeCompare(bText, undefined, { numeric: true, sensitivity: "base" });
  }

  function getSortedRows(sourceRows) {
    const rows = Array.isArray(sourceRows) ? sourceRows.slice() : [];
    const { columnKey, direction } = state.sortState || {};
    if (!columnKey || !direction) {
      return rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => {
          const aCreated =
            a.row && a.row.__sortValues && Object.prototype.hasOwnProperty.call(a.row.__sortValues, "Created Date")
              ? parseSortDateValue(a.row.__sortValues["Created Date"])
              : parseSortDateValue(a.row && a.row["Created Date"]);
          const bCreated =
            b.row && b.row.__sortValues && Object.prototype.hasOwnProperty.call(b.row.__sortValues, "Created Date")
              ? parseSortDateValue(b.row.__sortValues["Created Date"])
              : parseSortDateValue(b.row && b.row["Created Date"]);

          if (aCreated != null && bCreated != null) {
            if (aCreated !== bCreated) return bCreated - aCreated;
            return a.index - b.index;
          }
          if (aCreated != null) return -1;
          if (bCreated != null) return 1;
          return a.index - b.index;
        })
        .map((entry) => entry.row);
    }

    const column = getActiveColumnDefs().find((item) => item.key === columnKey);
    const multiplier = direction === "desc" ? -1 : 1;
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const aValue =
          a.row && a.row.__sortValues && Object.prototype.hasOwnProperty.call(a.row.__sortValues, columnKey)
            ? a.row.__sortValues[columnKey]
            : a.row[columnKey];
        const bValue =
          b.row && b.row.__sortValues && Object.prototype.hasOwnProperty.call(b.row.__sortValues, columnKey)
            ? b.row.__sortValues[columnKey]
            : b.row[columnKey];
        const compared = compareValuesForSort(aValue, bValue, column);
        if (compared !== 0) return compared * multiplier;
        return a.index - b.index;
      })
      .map((entry) => entry.row);
  }

  function updateSortState(columnIndex, columnKey) {
    const current = state.sortState || {};
    if (current.columnKey !== columnKey) {
      state.sortState = { columnKey, columnIndex, direction: "asc" };
      return;
    }

    if (current.direction === "asc") {
      state.sortState = { columnKey, columnIndex, direction: "desc" };
      return;
    }
    if (current.direction === "desc") {
      state.sortState = { columnKey: null, columnIndex: null, direction: null };
      return;
    }
    state.sortState = { columnKey, columnIndex, direction: "asc" };
  }

  function closeMoreMenu() {
    if (!ui.moreMenu || !ui.moreBtn) return;
    ui.moreMenu.hidden = true;
    ui.moreBtn.setAttribute("aria-expanded", "false");
  }

  function openMoreMenu() {
    if (!ui.moreMenu || !ui.moreBtn) return;
    ui.moreMenu.hidden = false;
    ui.moreBtn.setAttribute("aria-expanded", "true");
  }

  async function requestNewRecordGuid() {
    const response = await postJson(`${getAppApiBase()}/api/NewRecordGuid`, {});
    const id = String(response || "").trim();
    if (!id) throw new Error("Could not prepare a new record id.");
    return id;
  }

  async function getAssetViewId() {
    if (state.newAssetViewId) return state.newAssetViewId;
    const rows = await getAssetViewRows();
    const first = rows[0] || {};
    const viewId = String(first.ViewID || "").trim();
    if (!viewId) throw new Error("Could not resolve asset view id.");
    state.newAssetViewId = viewId;
    MASTER_EDIT_FORM.viewId = MASTER_EDIT_FORM.viewId || viewId;
    return viewId;
  }

  async function resolveRepositoryContext(repositoryName, signal, repositoryObjectKey) {
    const cacheKey = [String(repositoryName || "").trim().toLowerCase(), String(repositoryObjectKey || "").trim().toLowerCase()]
      .filter(Boolean)
      .join("|");
    if (!cacheKey) throw new Error("Repository name is required.");
    if (state.repositoryContextCache[cacheKey]) return state.repositoryContextCache[cacheKey];

    const candidates = [
      repositoryObjectKey,
      repositoryName,
      String(repositoryName || "").replace(/\s+/g, "_"),
      String(repositoryName || "").replace(/\s+/g, "")
    ]
      .map((item) => String(item || "").trim())
      .filter(Boolean);

    let objectInfo = null;
    const mightBeMasterRepository =
      isMasterRepositoryName(repositoryName) ||
      candidates.some((candidate) => isMasterRepositoryName(candidate));
    if (mightBeMasterRepository) {
      try {
        const masterRow = await fetchMasterObjectRow(signal);
        if (masterRow) {
          const resolvedObjectID = String(masterRow.ObjectID || masterRow.ObjectId || "").trim();
          if (resolvedObjectID) {
            objectInfo = {
              objectID: resolvedObjectID,
              objectName:
                String(masterRow.ObjectName || masterRow.Name || repositoryName || "").trim() ||
                repositoryName,
              fields: Array.isArray(masterRow.Fields) ? masterRow.Fields : []
            };
          }
        }
      } catch (_error) {
        // Fall through to repository candidate lookup.
      }
    }

    for (let i = 0; i < candidates.length && !objectInfo; i += 1) {
      const candidate = candidates[i];
      try {
        const payload = await fetchJson(
          `${getAppApiBase()}/api/ObjectGet?option=object&objectID=${encodeURIComponent(candidate)}`,
          signal
        );
        const rows = normalizeRecords(payload);
        const first = rows[0] || {};
        const resolvedObjectID = String(first.ObjectID || first.ObjectId || "").trim();
        if (resolvedObjectID) {
          objectInfo = {
            objectID: resolvedObjectID,
            objectName:
              String(first.ObjectName || first.Name || repositoryName || "").trim() || repositoryName,
            fields: Array.isArray(first.Fields) ? first.Fields : []
          };
          break;
        }
      } catch (_error) {
        // Try next candidate.
      }
    }

    if (!objectInfo) {
      throw new Error(`Unable to resolve repository ${repositoryName}.`);
    }

    let viewID = "";
    try {
      const viewPayload = await fetchJson(
        `${getAppApiBase()}/api/ViewGet?objectID=${encodeURIComponent(objectInfo.objectID)}`,
        signal
      );
      const viewRows = normalizeRecords(viewPayload);
      const firstView = viewRows[0] || {};
      viewID = String(firstView.ViewID || "").trim();
    } catch (_error) {
      // Keep fallback behavior.
    }

    const resolved = {
      objectID: objectInfo.objectID,
      objectName: objectInfo.objectName,
      viewID,
      fields: Array.isArray(objectInfo.fields) ? objectInfo.fields : []
    };
    state.repositoryContextCache[cacheKey] = resolved;
    return resolved;
  }

  async function getAssetViewRows(signal) {
    if (Array.isArray(state.assetViewRows) && state.assetViewRows.length) {
      return state.assetViewRows;
    }
    if (!state.assetViewRowsPromise) {
      state.assetViewRowsPromise = getMasterObjectId(signal)
        .then((objectID) =>
          fetchJson(
            `${getAppApiBase()}/api/ViewGet?objectID=${encodeURIComponent(objectID)}`,
            signal
          )
        )
        .then((payload) => {
          const rows = normalizeRecords(payload);
          state.assetViewRows = rows;
          const first = rows[0] || {};
          state.assetViewFields = parseAssetViewFields(first.ViewFields || first.viewFields || "[]");
          const viewId = String(first.ViewID || "").trim();
          if (viewId) state.newAssetViewId = viewId;
          return rows;
        })
        .finally(() => {
          state.assetViewRowsPromise = null;
        });
    }
    return state.assetViewRowsPromise;
  }

  function formatLookupPrefillValue(id, label) {
    const safeId = String(id || "").trim();
    const safeLabel = String(label || "").trim();
    if (!safeId && !safeLabel) return "";
    if (safeId.includes(";#")) return safeId;
    if (safeLabel.includes(";#")) return safeLabel;
    if (safeId && safeLabel) return `${safeId};#${safeLabel}`;
    return safeId || safeLabel;
  }

  /**
   * Finds a lookup field's GUID+label pair by name among the asset rows already fetched via
   * `api/rnsp` (state.rawRowsByRecordKey carries the raw, unstripped "GUID;#Label" values).
   * Used to resolve a route's Category/Type when the URL only supplied a name, without a
   * separate GetRecordsForFields/GetItems('EAsset_Category'|'EAsset_Type', ...) call.
   */
  function findLookupIdLabelFromLoadedRows(internalFieldName, nameKey) {
    if (!nameKey) return null;
    const rawRows = Object.values(state.rawRowsByRecordKey || {});
    for (let i = 0; i < rawRows.length; i += 1) {
      const merged = mergeRecordFieldValuesIntoRow(rawRows[i]);
      const raw = merged ? merged[internalFieldName] : undefined;
      if (raw == null) continue;
      const text = String(raw).trim();
      if (!text) continue;
      const id = parseLookupId(text);
      const label = parseLookupLabel(text);
      if (!id || !label) continue;
      if (normalizeCategoryToken(label) === nameKey) return { id, label };
    }
    return null;
  }

  async function resolveCategoryIdAndLabelForPrefill(categoryId, categoryLabel) {
    let id = String(categoryId || "").trim();
    let label = String(categoryLabel || "").trim();
    const nameKey = normalizeCategoryToken(label);

    if (isGuid(id)) return { categoryId: id, categoryLabel: label };
    if (nameKey) {
      const match = findLookupIdLabelFromLoadedRows("Category", nameKey);
      if (match) {
        id = match.id;
        label = match.label;
      }
    }

    return { categoryId: id, categoryLabel: label };
  }

  async function resolveTypeIdAndLabelForPrefill(typeId, typeLabel) {
    let id = String(typeId || "").trim();
    let label = String(typeLabel || "").trim();
    const nameKey = normalizeCategoryToken(label);

    if (isGuid(id)) return { typeId: id, typeLabel: label };
    if (nameKey) {
      const match = findLookupIdLabelFromLoadedRows("Type", nameKey);
      if (match) {
        id = match.id;
        label = match.label;
      }
    }

    return { typeId: id, typeLabel: label };
  }

  async function ensureRouteScopeResolved(signal) {
    const [resolvedCategory, resolvedType] = await Promise.all([
      resolveCategoryIdAndLabelForPrefill(state.categoryId, state.categoryLabel),
      resolveTypeIdAndLabelForPrefill(state.typeId, state.typeLabel)
    ]);
    state.categoryId = String(resolvedCategory.categoryId || "").trim();
    state.categoryLabel = String(resolvedCategory.categoryLabel || state.categoryLabel || "").trim();
    state.typeId = String(resolvedType.typeId || "").trim();
    state.typeLabel = String(resolvedType.typeLabel || state.typeLabel || "").trim();

    if (signal && signal.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }
  }

  /** + New: Type/Category from route; all other EAsset_Master fields undefined. */
  async function openEAssetMasterNewRecordOutOfBoxForm() {
    if (isToolbarCreationRestricted()) return;
    syncBundleEnvUrl();
    const qafPage = findHostQafPageService();
    if (!qafPage || typeof qafPage.AddItem !== "function") {
      throw new Error("QafPageService.AddItem is not available.");
    }
    const onSaved = () => loadDataAfterSave();
    const route = getRouteParams();
    const resolvedType = await resolveTypeIdAndLabelForPrefill(route.typeId, route.typeName);
    const typeVal = formatLookupPrefillValue(resolvedType.typeId, resolvedType.typeLabel);
    const categoryVal = formatLookupPrefillValue(route.categoryId, route.categoryName);
    if (!typeVal && !categoryVal) {
      qafPage.AddItem(MASTER_LIST_OBJECT_NAME, onSaved);
      return;
    }
    const masterRow = await fetchMasterObjectRow(undefined);
    const fields =
      masterRow && Array.isArray(masterRow.Fields) ? masterRow.Fields : [];
    const showFieldsWithValue = fields
      .filter((field) => field && field.InternalName)
      .map((field) => ({
        fieldName: field.InternalName,
        fieldValue:
          field.InternalName === "Type" && typeVal
            ? typeVal
            : field.InternalName === "Category" && categoryVal
              ? categoryVal
              : undefined
      }));
    qafPage.AddItem(MASTER_LIST_OBJECT_NAME, onSaved, undefined, showFieldsWithValue);
  }

  function tryLaunchRepositoryOutOfBoxForm(context) {
    const services = [window.QafPageService, window.parent && window.parent.QafPageService].filter(Boolean);
    const methods = [
      "AddItem",
      "AddNewItem",
      "CreateItem",
      "OpenCreateItem",
      "OpenNewItem",
      "NewItem"
    ];
    const recordFieldValues = Array.isArray(context.recordFieldValues) ? context.recordFieldValues : [];
    const repository = String(context.repository || "").trim();
    const objectName = String(context.objectName || "").trim();
    const nameHints = [repository, objectName].filter(Boolean);
    const argsList = [
      [{ ...context }],
      [{ ...context, mode: "new", DrMode: false, drMode: false }],
      [context.objectID, context.viewID, context.recordID, false, recordFieldValues],
      [context.objectID, context.viewID, context.recordID, recordFieldValues],
      [context.objectID, context.viewID, context.recordID, false],
      [context.objectID, context.viewID, context.recordID]
    ];
    for (let h = 0; h < nameHints.length; h += 1) {
      const hint = nameHints[h];
      argsList.push([hint, context.objectID, context.viewID, context.recordID, recordFieldValues]);
      argsList.push([hint, context.objectID, context.viewID, context.recordID, false, recordFieldValues]);
      argsList.push([hint, context]);
      argsList.push([hint, context.recordID, context.viewID]);
    }

    for (let i = 0; i < services.length; i += 1) {
      const service = services[i];
      for (let m = 0; m < methods.length; m += 1) {
        const fn = service && service[methods[m]];
        if (typeof fn !== "function") continue;
        for (let a = 0; a < argsList.length; a += 1) {
          try {
            fn.apply(service, argsList[a]);
            return true;
          } catch (_error) {
            // Try next signature.
          }
        }
      }
    }
    return false;
  }

  function openRepositoryIFormFallbackUrl(context) {
    const baseUrl = `${window.location.origin}/workflow-engine/i-form`;
    const params = new URLSearchParams({
      objectID: context.objectID,
      viewID: context.viewID,
      recordID: context.recordID,
      mode: "new",
      drMode: "false"
    });
    window.location.assign(`${baseUrl}?${params.toString()}`);
  }

  /**
   * Allocate / Deallocate OOTB new-record: same pre-flight as + New on master (ObjectGet, ViewGet,
   * GetRecords), plus `QafService.GetItems` from bundle.js to warm the portal service.
   * `repositoryObjectName` is the portal object name (e.g. `EAsset_Allocation`).
   */
  async function openRepositoryChildNewRecordOotbLikeEAssetMaster({ repositoryObjectName, signal }) {
    markRefreshOnReturn();
    const objectName = String(repositoryObjectName || "").trim();
    if (!objectName) throw new Error("Repository object name is required.");

    const repoContext = await resolveRepositoryContext(objectName, signal, objectName);
    if (!repoContext || !repoContext.objectID) {
      throw new Error(`Could not resolve object for ${objectName}.`);
    }
    let viewID = String(repoContext.viewID || "").trim();
    if (!viewID) {
      const viewTargets = [objectName, repoContext.objectID].filter(Boolean);
      for (let i = 0; i < viewTargets.length; i += 1) {
        try {
          const viewPayload = await fetchJson(
            `${getAppApiBase()}/api/ViewGet?objectID=${encodeURIComponent(viewTargets[i])}`,
            signal
          );
          const viewRows = normalizeRecords(viewPayload);
          const firstView = viewRows[0] || {};
          viewID = String(firstView.ViewID || "").trim();
          if (viewID) break;
        } catch (_error) {
          // Try next target.
        }
      }
    }
    if (!viewID) {
      throw new Error(`Could not resolve view for ${objectName}.`);
    }

    const objectID = repoContext.objectID;
    const recordsParams = new URLSearchParams({
      viewID
    });

    const qaf = getQafService();
    const getItemsWarmup =
      qaf && typeof qaf.GetItems === "function"
        ? promiseWithAbort(
            signal,
            qaf.GetItems(objectName, ["RecordID"], 1, 1, "", "", true)
          ).catch(() => null)
        : Promise.resolve(null);

    try {
      // ObjectGet/ViewGet already ran in resolveRepositoryContext; warm portal service + records only.
      await Promise.all([getItemsWarmup]);
      await fetchJson(
        `${getAppApiBase()}/api/GetRecords?${recordsParams.toString()}`,
        signal
      ).catch(() => []);
    } catch (_error) {
      // Pre-flight failures should not block opening the form.
    }

    const recordID = await requestNewRecordGuid();

    const qafPageService = window.QafPageService || (window.parent && window.parent.QafPageService);
    const targets = [objectName, repoContext.objectName, objectID]
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    const uniqueTargets = [...new Set(targets)];

    const noop = function () {};
    /** Empty array keeps the same `AddItem` signatures as + New without pre-filling any fields. */
    const recordFieldValues = [];

    if (qafPageService) {
      const methods = ["AddItem", "AddNewItem", "CreateItem"];
      for (let m = 0; m < methods.length; m += 1) {
        const fn = qafPageService[methods[m]];
        if (typeof fn !== "function") continue;
        for (let i = 0; i < uniqueTargets.length; i += 1) {
          const target = uniqueTargets[i];
          const contextObj = {
            objectID,
            viewID,
            recordID,
            mode: "new",
            drMode: false,
            DrMode: false
          };
          const argSets = [
            [target, recordID, noop],
            [target, viewID, recordID, false, recordFieldValues],
            [target, viewID, recordID, recordFieldValues],
            [target, recordID, viewID],
            [objectID, viewID, recordID, false, recordFieldValues],
            [objectID, viewID, recordID, recordFieldValues],
            [objectID, viewID, recordID, false],
            [objectID, viewID, recordID],
            [contextObj],
            [{ ...contextObj, repository: target }],
            [target, objectID, viewID, recordID, false, recordFieldValues, noop],
            [target, objectID, viewID, recordID, noop]
          ];
          for (let a = 0; a < argSets.length; a += 1) {
            try {
              fn.apply(qafPageService, argSets[a]);
              return;
            } catch (_error) {
              // Try next signature.
            }
          }
        }
      }
    }

    const formUrl = new URL(`${window.location.origin}/workflow-engine/i-form`);
    formUrl.searchParams.set("mode", "new");
    formUrl.searchParams.set("objectID", objectID);
    formUrl.searchParams.set("viewID", viewID);
    formUrl.searchParams.set("recordID", recordID);
    formUrl.searchParams.set("drMode", "false");
    window.location.assign(formUrl.toString());
  }

  async function openEAssetAllocationNewRecordOotbForm(signal) {
    await openRepositoryChildNewRecordOotbLikeEAssetMaster({
      repositoryObjectName: "EAsset_Allocation",
      signal
    });
  }

  async function openEAssetDeallocationNewRecordOotbForm(signal) {
    await openRepositoryChildNewRecordOotbLikeEAssetMaster({
      repositoryObjectName: "EAsset_Deallocation",
      signal
    });
  }

  // --- Allocation/deallocation form prefill (mirrors search.js) ---
  const allocationFormPrefill = (function () {
    "use strict";
    var FETCH_CHUNK_SIZE = 500;
    var prefillBridge = null;
    var state = {
      employeeRows: [],
      employeeOptions: [],
      employeeNameByGuid: {},
      inFlightGetRecordsRequests: {},
      allAssets: [],
      searchAssets: [],
    };
    var employeeDataLoadPromise = null;
      var ASSET_OBJECT = "EAsset_Master";
      var ASSET_OBJECT_CANDIDATES = ["EAsset_Master"];
      var cachedMasterAssetFieldList = null;
      var masterAssetFieldListPromise = null;

      function buildFieldListCsvFromObjectFields(fields, extraNames) {
        var seen = {};
        var names = [];
        function add(name) {
          var value = toText(name);
          if (!value || seen[value.toLowerCase()]) return;
          seen[value.toLowerCase()] = true;
          names.push(value);
        }
        add("RecordID");
        (Array.isArray(extraNames) ? extraNames : []).forEach(add);
        (Array.isArray(fields) ? fields : []).forEach(function (field) {
          add(field && field.InternalName);
        });
        return names.join(",");
      }

      function resolveMasterAssetFieldList() {
        if (cachedMasterAssetFieldList) return Promise.resolve(cachedMasterAssetFieldList);
        if (masterAssetFieldListPromise) return masterAssetFieldListPromise;
        masterAssetFieldListPromise = fetchObjectMetadataOnce(ASSET_OBJECT)
          .then(function (row) {
            var fields = row && Array.isArray(row.Fields) ? row.Fields : [];
            cachedMasterAssetFieldList = buildFieldListCsvFromObjectFields(fields);
            return cachedMasterAssetFieldList;
          })
          .catch(function () {
            cachedMasterAssetFieldList = "RecordID";
            return cachedMasterAssetFieldList;
          })
          .finally(function () {
            masterAssetFieldListPromise = null;
          });
        return masterAssetFieldListPromise;
      }
    
      var ALLOCATION_FORM = {
        formName: "EAsset_Allocation",
        repositoryName: "EAsset_Allocation",
        objectId: "940ba223-29cf-4f17-96a6-1e1bc4cd7385",
        viewId: "",
        objectNameCandidates: ["EAsset_Allocation", "EAsset Allocation"],
      };
      var DEALLOCATION_FORM = {
        formName: "EAsset_Deallocation",
        repositoryName: "EAsset_Deallocation",
        objectId: "",
        viewId: "",
        objectNameCandidates: ["EAsset_Deallocation", "EAsset Deallocation"],
      };
    
      var MASTER_EDIT = {
        formName: "EAsset_Master",
        repositoryName: "EAsset_Master",
        objectId: "",
        viewId: "",
        objectNameCandidates: ["EAsset_Master", "EAsset Master", "Easset_Master", "Asset_Master"],
      };
    
      var resolvedFormConfigCache = {};
      var objectMetadataByKeyCache = {};
      var viewIdByObjectIdCache = {};
      var inflightResolveFormConfig = {};
      var cachedNewRecordGuidPromise = null;
      var fetchRecordsPageCache = {};
      var assetRowByRecordIdCache = {};
      var filterOptionsApiCache = {};
      var employeeDataLoadPromise = null;
    
      function getPrimaryRepositoryLookupKey(formConfig) {
        var cfg = formConfig || {};
        if (isDeallocationForm(cfg)) return "EAsset_Deallocation";
        if (isAllocationFormConfig(cfg)) return "EAsset_Allocation";
        return toText(cfg.repositoryName || cfg.formName);
      }
    
      function cacheObjectMetadataRow(row, lookupKeys) {
        if (!row) return;
        var keys = Array.isArray(lookupKeys) ? lookupKeys : [lookupKeys];
        var objectId = readObjectIdFromMetadataRow(row);
        if (objectId) keys.push(objectId);
        keys.forEach(function (key) {
          var cacheKey = toText(key).toLowerCase();
          if (!cacheKey) return;
          objectMetadataByKeyCache[cacheKey] = Promise.resolve(row);
        });
      }
    
      function fetchObjectMetadataOnce(lookupKey) {
        var key = toText(lookupKey);
        if (!key) return Promise.resolve(null);
        var cacheKey = key.toLowerCase();
        if (objectMetadataByKeyCache[cacheKey]) return objectMetadataByKeyCache[cacheKey];
    
        var requestPromise = postApiJson(
          "/api/ObjectGet?option=object&objectID=" + encodeURIComponent(key)
        )
          .then(function (payload) {
            var row = extractFirstApiRow(payload);
            if (row && (readObjectIdFromMetadataRow(row) || Array.isArray(row.Fields))) {
              cacheObjectMetadataRow(row, [key, readObjectIdFromMetadataRow(row)]);
              return row;
            }
            return null;
          })
          .catch(function () {
            return null;
          });
    
        objectMetadataByKeyCache[cacheKey] = requestPromise;
        return requestPromise;
      }
    
      function fetchViewIdOnce(objectId) {
        var safeObjectId = toText(objectId);
        if (!safeObjectId) return Promise.resolve("");
        var cacheKey = safeObjectId.toLowerCase();
        if (viewIdByObjectIdCache[cacheKey] != null) return viewIdByObjectIdCache[cacheKey];
    
        var requestPromise = postApiJson("/api/ViewGet?objectID=" + encodeURIComponent(safeObjectId))
          .then(function (payload) {
            var row = extractFirstApiRow(payload);
            return toText(row && (row.ViewID || row.viewId || row.ID || row.Id));
          })
          .catch(function () {
            return "";
          });
    
        viewIdByObjectIdCache[cacheKey] = requestPromise;
        return requestPromise;
      }
    
      function fetchNewRecordGuidOnce() {
        if (cachedNewRecordGuidPromise) return cachedNewRecordGuidPromise;
        cachedNewRecordGuidPromise = fetchNewRecordGuid().then(function (guid) {
          // Reset after consumption so the next form open fetches a fresh GUID
          // instead of reusing the same one (which caused duplicate NewRecordGuid on Assign).
          cachedNewRecordGuidPromise = null;
          return guid;
        });
        return cachedNewRecordGuidPromise;
      }
    
      function toText(value) {
        return String(value == null ? "" : value).trim();
      }
    
      function toFieldMap(row) {
        var map = {};
        var fields = Array.isArray(row && row.RecordFieldValues) ? row.RecordFieldValues : [];
        fields.forEach(function (field) {
          var key = toText(field.FieldInternalName || field.dsNm || field.FieldName).toLowerCase();
          if (!key) return;
          var value =
            field.FieldValue != null
              ? field.FieldValue
              : field.UFieldValue != null
                ? field.UFieldValue
                : field.Value != null
                  ? field.Value
                  : "";
          map[key] = value;
        });
        return map;
      }
    
      function enrichRow(row) {
        if (!row || typeof row !== "object") return row;
        var fieldMap = toFieldMap(row);
        return Object.assign({ __fieldMap: fieldMap }, row);
      }
    
      function getValue(row, keys) {
        if (!row || typeof row !== "object") return "";
        var list = Array.isArray(keys) ? keys : [keys];
        for (var i = 0; i < list.length; i += 1) {
          var key = list[i];
          if (row[key] != null && toText(row[key])) return toText(row[key]);
          var mapKey = toText(key).toLowerCase();
          if (row.__fieldMap && row.__fieldMap[mapKey] != null && toText(row.__fieldMap[mapKey])) {
            return toText(row.__fieldMap[mapKey]);
          }
        }
        return "";
      }
    
      function lookupToText(value) {
        var L = lib();
        if (L.lookupToText) return L.lookupToText(value, "");
        var text = toText(value);
        if (!text) return "";
        if (text.indexOf(";#") >= 0) return text.split(";#").pop().trim();
        return text;
      }
    
      function lookupId(value) {
        var text = toText(value);
        if (!text) return "";
        return text.indexOf(";#") >= 0 ? text.split(";#")[0].trim() : text;
      }
    
      function lib() {
        return window.QafLibrary || {};
      }
    
      function isGuid(value) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(toText(value));
      }
    
      function unwrapAssignedToValue(raw, depth) {
        var current = raw;
        depth = depth || 0;
        if (depth > 5 || current == null) return current;
        if (typeof current === "object") return current;
        var text = toText(current);
        if (!text) return current;
        var looksJson =
          text.charAt(0) === '"' ||
          text.startsWith("[") ||
          text.startsWith("{") ||
          /RecordID/i.test(text);
        if (!looksJson) return current;
        try {
          var parsed = JSON.parse(text);
          if (typeof parsed === "string") return unwrapAssignedToValue(parsed, depth + 1);
          return parsed;
        } catch (_) {
          return current;
        }
      }
    
      function extractRecordIdFromAssignedItem(item) {
        if (item == null) return "";
        if (typeof item === "string") return isGuid(item) ? normalizeRecordId(item) : "";
        if (typeof item !== "object") return "";
        return toText(item.RecordID || item.recordID || item.RecordId);
      }
    
      function normalizeRecordId(value) {
        return toText(value).trim().toLowerCase();
      }
    
      function parseAssignedRecordIds(raw) {
        var unwrapped = unwrapAssignedToValue(raw);
        if (unwrapped != null && typeof unwrapped === "object") {
          var objectList = Array.isArray(unwrapped) ? unwrapped : [unwrapped];
          return objectList
            .map(extractRecordIdFromAssignedItem)
            .filter(function (id) {
              return id && isGuid(id);
            });
        }
        var text = toText(unwrapped);
        if (!text) return [];
        if (text.startsWith("[") || text.startsWith("{") || text.charAt(0) === '"') {
          try {
            return parseAssignedRecordIds(JSON.parse(text));
          } catch (_) {
            var match = toText(text).match(/"RecordID"\s*:\s*"([0-9a-f-]{36})"/i);
            if (match && match[1]) return [normalizeRecordId(match[1])];
            return [];
          }
        }
        if (text.indexOf(";#") >= 0) {
          var lookup = normalizeRecordId(lookupId(text));
          return lookup && isGuid(lookup) ? [lookup] : [];
        }
        if (isGuid(text)) return [normalizeRecordId(text)];
        return [];
      }
    
      function extractAssignedToRecordIds(raw) {
        return parseAssignedRecordIds(raw)
          .map(normalizeRecordId)
          .filter(function (id) {
            return id && isGuid(id);
          });
      }
    
      var ASSIGNED_TO_LOG_PREFIX = "[AssetDetails][AssignedTo]";
    
      function isBlankDisplayValue(value) {
        var L = lib();
        if (L.isBlankDisplayValue) return L.isBlankDisplayValue(value);
        var text = toText(value);
        if (!text) return true;
        if (/^[\u2013\u2014\u2212\-ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬ ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬ ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â]+$/.test(text)) return true;
        if (/^\u00e2\u20ac[\u201c\u0093"-]?$/.test(text)) return true;
        if (/^(undefined|null|n\/a|na)$/i.test(text)) return true;
        if (/^\[object object\]$/i.test(text)) return true;
        if (/^invalid date$/i.test(text)) return true;
        return false;
      }
    
      function displayFieldValue(value) {
        var L = lib();
        if (L.displayFieldValue) return L.displayFieldValue(value);
        if (isBlankDisplayValue(value)) return "";
        return toText(value);
      }
    
      function displayLookupFieldValue(value) {
        var L = lib();
        if (L.displayLookupFieldValue) return L.displayLookupFieldValue(value);
        if (isBlankDisplayValue(value)) return "";
        var text = lookupToText(value);
        if (isBlankDisplayValue(text)) return "";
        return text;
      }
    
      function normalizeRows(payload) {
        if (Array.isArray(payload)) return payload;
        if (!payload || typeof payload !== "object") return [];
        var keys = ["rows", "Rows", "data", "Data", "items", "Items", "result", "Result", "value", "Value"];
        for (var i = 0; i < keys.length; i += 1) {
          if (Array.isArray(payload[keys[i]])) return payload[keys[i]];
        }
        return [];
      }
    
      function isEmployeeActive(row) {
        var off = toText(getValue(row, ["IsOffboarded"])).toLowerCase();
        return off !== "true";
      }
    
      function normalizeFieldKey(name) {
        return toText(name).toLowerCase().replace(/[^a-z0-9]/g, "");
      }
    
      function getRawField(row, name) {
        if (!row || typeof row !== "object") return "";
        if (row[name] != null && row[name] !== "") return row[name];
        var target = normalizeFieldKey(name);
        if (row.__fieldMap) {
          var mapKeys = Object.keys(row.__fieldMap);
          for (var m = 0; m < mapKeys.length; m += 1) {
            if (normalizeFieldKey(mapKeys[m]) !== target) continue;
            var mapped = row.__fieldMap[mapKeys[m]];
            if (mapped != null && mapped !== "") return mapped;
          }
        }
        var fields = Array.isArray(row.RecordFieldValues) ? row.RecordFieldValues : [];
        for (var i = 0; i < fields.length; i += 1) {
          var field = fields[i];
          var key = normalizeFieldKey(field.FieldInternalName || field.dsNm || field.FieldName);
          if (key !== target) continue;
          var val =
            field.FieldValue != null
              ? field.FieldValue
              : field.UFieldValue != null
                ? field.UFieldValue
                : field.Value != null
                  ? field.Value
                  : "";
          if (val != null && val !== "") return val;
        }
        return "";
      }
    
      function fieldValueToText(value) {
        if (value == null || value === "") return "";
        if (typeof value === "object") {
          if (value.DisplayName != null) return displayFieldValue(value.DisplayName);
          if (value.Name != null) return displayFieldValue(value.Name);
          if (value.Value != null) return fieldValueToText(value.Value);
          if (value.FieldValue != null) return fieldValueToText(value.FieldValue);
          return "";
        }
        var text = toText(value);
        if (isBlankDisplayValue(text) || text === "[object Object]") return "";
        if (
          (text.charAt(0) === "{" && text.indexOf("}") >= 0) ||
          (text.charAt(0) === "[" && text.indexOf("]") >= 0)
        ) {
          try {
            var parsed = JSON.parse(text);
            if (parsed && typeof parsed === "object") {
              if (parsed.DisplayName != null) return displayFieldValue(parsed.DisplayName);
              if (parsed.Name != null) return displayFieldValue(parsed.Name);
              if (parsed.FirstName != null || parsed.LastName != null) {
                return displayFieldValue((toText(parsed.FirstName) + " " + toText(parsed.LastName)).trim());
              }
            }
          } catch (_) {
            return "";
          }
          return "";
        }
        if (text.indexOf(";#") >= 0) return displayLookupFieldValue(text);
        return displayFieldValue(text);
      }
    
      function getEmployeeDisplayName(row) {
        var first = fieldValueToText(getRawField(row, "FirstName"));
        var last = fieldValueToText(getRawField(row, "LastName"));
        if (!first) first = fieldValueToText(getValue(row, ["FirstName"]));
        if (!last) last = fieldValueToText(getValue(row, ["LastName"]));
        return (first + " " + last).trim();
      }
    
      function getEmployeeRecordIdField(row) {
        var fromField = fieldValueToText(getRawField(row, "RecordID"));
        if (fromField) return normalizeRecordId(fromField);
        if (row && row.RecordID != null && toText(row.RecordID)) {
          return normalizeRecordId(row.RecordID);
        }
        var fields = Array.isArray(row && row.RecordFieldValues) ? row.RecordFieldValues : [];
        for (var i = 0; i < fields.length; i += 1) {
          var field = fields[i];
          var key = normalizeFieldKey(field.FieldInternalName || field.dsNm || field.FieldName);
          if (key !== "recordid") continue;
          var val =
            field.FieldValue != null
              ? field.FieldValue
              : field.UFieldValue != null
                ? field.UFieldValue
                : field.Value;
          var text = toText(fieldValueToText(val));
          if (text) return normalizeRecordId(text);
        }
        return "";
      }
    
      function getEmployeeFirstLastName(row) {
        var first = toText(fieldValueToText(getRawField(row, "FirstName"))).trim();
        var last = toText(fieldValueToText(getRawField(row, "LastName"))).trim();
        return {
          firstName: first,
          lastName: last,
          fullName: (first + " " + last).trim(),
        };
      }
    
      function resolveEmployeeNameByRecordIdMatch(assignedRecordId, assignedRaw) {
        var targetId = normalizeRecordId(assignedRecordId);
        if (!targetId || !isGuid(targetId)) return "";
    
        console.info(ASSIGNED_TO_LOG_PREFIX, {
          message: "Extracted AssignedTo RecordID",
          assignedRecordId: targetId,
          assignedToRaw: assignedRaw,
        });
    
        var employees = state.employeeRows || [];
        for (var i = 0; i < employees.length; i += 1) {
          var employeeRow = employees[i];
          var employeeRecordId = getEmployeeRecordIdField(employeeRow);
          var isMatch = employeeRecordId === targetId;
    
          console.info(ASSIGNED_TO_LOG_PREFIX, {
            message: "Comparing employee RecordID",
            assignedRecordId: targetId,
            employeeRecordId: employeeRecordId,
            match: isMatch,
          });
    
          if (!isMatch) continue;
    
          var nameParts = getEmployeeFirstLastName(employeeRow);
          console.info(ASSIGNED_TO_LOG_PREFIX, {
            message: "Employee match found",
            assignedRecordId: targetId,
            employeeRecordId: employeeRecordId,
            firstName: nameParts.firstName,
            lastName: nameParts.lastName,
            displayName: nameParts.fullName,
          });
    
          return nameParts.fullName;
        }
    
        console.warn(ASSIGNED_TO_LOG_PREFIX, {
          message: "No employee RecordID match",
          assignedRecordId: targetId,
          employeeRowCount: employees.length,
        });
        return "";
      }
    
      function resolveEmployeeName(rawValue) {
        var assignedRecordIds = extractAssignedToRecordIds(rawValue);
        if (!assignedRecordIds.length) return "";
        var names = [];
        assignedRecordIds.forEach(function (assignedRecordId) {
          var name = resolveEmployeeNameByRecordIdMatch(assignedRecordId, rawValue);
          if (name && names.indexOf(name) < 0) names.push(name);
        });
        return names.join(", ");
      }
    
      function resolveAssignedToDisplay(row) {
        var assignedRaw = getRawField(row, "AssignedTo");
        if (assignedRaw == null || assignedRaw === "") assignedRaw = getValue(row, ["AssignedTo"]);
        if (isBlankDisplayValue(assignedRaw)) return "";
        return resolveEmployeeName(assignedRaw);
      }
    
      function buildEmployeeFilterOptions(rows) {
        return rows
          .map(function (row) {
            var id = getValue(row, ["RecordID"]);
            var label = (getValue(row, ["FirstName"]) + " " + getValue(row, ["LastName"])).trim();
            if (!id || !label) return null;
            var queryValue = id + ";#" + label;
            return {
              value: id,
              label: label,
              queryValue: queryValue,
              queryCandidates: [queryValue, id, label],
            };
          })
          .filter(Boolean)
          .sort(function (a, b) {
            return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
          });
      }
    
      function isUsableEmployeeId(value) {
        var text = toText(value);
        if (!text || text === "[object Object]") return false;
        if (/[\[\]{}]/.test(text)) return false;
        return true;
      }
    
      function getEmployeeRecordId(row) {
        var candidates = [
          fieldValueToText(getRawField(row, "RecordID")),
          fieldValueToText(getValue(row, ["RecordID", "RecordId", "recordID", "ID", "Id"])),
          fieldValueToText(getRawField(row, "EmployeeID")),
          fieldValueToText(getValue(row, ["EmployeeID"])),
        ];
        var i;
        for (i = 0; i < candidates.length; i += 1) {
          if (isGuid(candidates[i])) return candidates[i];
        }
        for (i = 0; i < candidates.length; i += 1) {
          if (isUsableEmployeeId(candidates[i])) return candidates[i];
        }
        return "";
      }
    
      function buildFetchRecordsPageCacheKey(config) {
        var cfg = config || {};
        var objectNames = cfg.objectNames || [cfg.objectName || ASSET_OBJECT];
        var names = (Array.isArray(objectNames) ? objectNames : [objectNames]).join("|");
        return [
          names,
          cfg.fieldList || "",
          cfg.pageSize || "",
          cfg.pageNumber || "",
          cfg.whereClause == null ? "" : String(cfg.whereClause),
          cfg.isAscending !== false,
        ].join("::");
      }
    
      /** Prefer QafService.GetItems (bundle.js) ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â avoids library view fallback that can 500. */
      function fetchRecordsPageUncached(options) {
        var config = options || {};
        var objectNames = config.objectNames || [config.objectName || ASSET_OBJECT];
        var pageSize = Number(config.pageSize || FETCH_CHUNK_SIZE);
        var pageNumber = Number(config.pageNumber || 1);
        var whereClause = config.whereClause == null ? "" : String(config.whereClause);
        var isAscending = config.isAscending !== false;
        var fieldListPromise = config.fieldList
          ? Promise.resolve(config.fieldList)
          : resolveMasterAssetFieldList();

        return fieldListPromise.then(function (fieldList) {
          var fields = String(fieldList)
            .split(",")
            .map(function (f) {
              return f.trim();
            })
            .filter(Boolean);

          if (!window.QafService || typeof window.QafService.GetItems !== "function") {
            return Promise.resolve([]);
          }

          var tryIndex = 0;
          var bestRows = [];

          function tryNext() {
            if (tryIndex >= objectNames.length) return Promise.resolve(bestRows);
            var objectName = objectNames[tryIndex];
            tryIndex += 1;
            return window.QafService.GetItems(objectName, fields, pageSize, pageNumber, whereClause, "", isAscending)
              .then(function (payload) {
                if (payload === false) return tryNext();
                var rows = normalizeRows(payload).map(enrichRow);
                if (rows.length > bestRows.length) bestRows = rows;
                if (rows.length) return bestRows;
                return tryNext();
              })
              .catch(function () {
                return tryNext();
              });
          }

          return tryNext();
        });
      }
    
      function fetchRecordsPage(options) {
        var cacheKey = buildFetchRecordsPageCacheKey(options);
        if (fetchRecordsPageCache[cacheKey]) return fetchRecordsPageCache[cacheKey];
        var requestPromise = fetchRecordsPageUncached(options);
        fetchRecordsPageCache[cacheKey] = requestPromise;
        return requestPromise;
      }
    
      function dedupeByRecordId(rows) {
        var seen = {};
        var out = [];
        (Array.isArray(rows) ? rows : []).forEach(function (row) {
          var id = getValue(row, ["RecordID", "RecordId", "recordID", "ID", "Id"]).toLowerCase();
          var key = id || JSON.stringify(row);
          if (seen[key]) return;
          seen[key] = true;
          out.push(row);
        });
        return out;
      }
    
      function fetchAllRecords(options) {
        var config = options || {};
        var page = 1;
        var all = [];
    
        function next() {
          return fetchRecordsPage(
            Object.assign({}, config, {
              pageNumber: page,
              pageSize: config.pageSize || FETCH_CHUNK_SIZE,
            })
          ).then(function (batch) {
            if (!batch.length) return all;
            all = all.concat(batch);
            if (batch.length < (config.pageSize || FETCH_CHUNK_SIZE)) return all;
            page += 1;
            if (page > 400) return all;
            return next();
          });
        }
    
        return next().then(function () {
          return dedupeByRecordId(all);
        });
      }
    
      async function loadEmployeeData() {
        if (Array.isArray(state.employeeRows) && state.employeeRows.length) return;
        if (employeeDataLoadPromise) return employeeDataLoadPromise;
        employeeDataLoadPromise = (async function () {
          var rows = [];
          try {
            rows = await fetchAllRecords({
              objectName: "Employees",
              objectNames: ["Employees"],
              fieldList: "RecordID,FirstName,LastName,PhotoUrl,IsOffboarded,CreatedByGUID,EmployeeID",
              pageSize: FETCH_CHUNK_SIZE,
              whereClause: "",
              isAscending: true,
            });
          } catch (_) {
            rows = [];
          }
          rows = rows.filter(isEmployeeActive);
          state.employeeRows = rows.slice();
          state.employeeOptions = buildEmployeeFilterOptions(rows);
        })();
        return employeeDataLoadPromise;
      }
    
      function getApiBaseUrl() {
        var envBase = toText(window.APP_ENV && window.APP_ENV.API_BASE_URL);
        if (envBase) return envBase.replace(/\/+$/, "");
        return "https://ndem.quickappflow.com";
      }
    
      function getEnvBaseUrl() {
        try {
          var envRaw = localStorage.getItem("env");
          if (envRaw) {
            var envVal = envRaw.trim();
            if (envVal.startsWith("{")) {
              var envObj = JSON.parse(envVal);
              var base = toText(envObj.baseUrl || envObj.BaseUrl || envObj.base || envObj.Base || envObj.apiBase || envObj.ApiBase || "");
              if (base) return base.replace(/\/+$/, "");
            }
            if (/^https?:\/\//i.test(envVal)) return envVal.replace(/\/+$/, "");
          }
        } catch (_) {}
        return getApiBaseUrl();
      }
    
      function getApiAuthHeaders() {
        var parsed = null;
        try {
          parsed = JSON.parse(localStorage.getItem("user_key") || "null");
        } catch (_) {
          parsed = null;
        }
        var parsedValue = parsed && parsed.value;
        if (typeof parsedValue === "string") {
          try {
            parsedValue = JSON.parse(parsedValue);
          } catch (_) {
            parsedValue = null;
          }
        }
        var payload =
          (parsedValue && typeof parsedValue === "object" && parsedValue) ||
          (parsed && typeof parsed === "object" && parsed) ||
          {};
        return {
          "Content-Type": "application/json",
          employeeguid: payload.employeeguid || payload.EmployeeGUID || "",
          hrzemail: payload.hrzemail || payload.Email || "",
          hrzempid: payload.hrzempid || payload.EmployeeID || "",
          lngs: payload.lngs || "Asia/Kolkata",
        };
      }
    
      function postApiJson(path) {
        var url = /^https?:\/\//i.test(path) ? path : getEnvBaseUrl() + path;
        return fetch(url, {
          method: "POST",
          headers: getApiAuthHeaders(),
          body: "{}",
        }).then(function (response) {
          if (!response || !response.ok) throw new Error("Request failed");
          return response.json();
        });
      }
    
      function parseNewRecordGuid(payload) {
        if (typeof payload === "string") return toText(payload);
        if (Array.isArray(payload)) {
          for (var i = 0; i < payload.length; i += 1) {
            var candidate = toText(payload[i]);
            if (/^[0-9a-f-]{36}$/i.test(candidate)) return candidate;
          }
          return "";
        }
        if (payload && typeof payload === "object") {
          return toText(
            payload.RecordID ||
              payload.recordID ||
              payload.guid ||
              payload.Guid ||
              payload.ID ||
              payload.Id ||
              payload.id
          );
        }
        return "";
      }
    
      function fetchNewRecordGuid() {
        var qafService = window.QafService || (window.parent && window.parent.QafService) || null;
        var fromService =
          qafService && typeof qafService.GetNewGUID === "function"
            ? Promise.resolve(qafService.GetNewGUID())
                .then(parseNewRecordGuid)
                .catch(function () {
                  return "";
                })
            : Promise.resolve("");
        return postApiJson("/api/NewRecordGuid")
          .then(parseNewRecordGuid)
          .catch(function () {
            return "";
          })
          .then(function (guid) {
            if (guid) return guid;
            return fromService;
          });
      }
    
    
      function fetchAssetRowByRecordIdCached(recordId) {
        var safeId = toText(recordId);
        if (!safeId) return Promise.resolve(null);
        var cacheKey = safeId.toLowerCase();
        if (assetRowByRecordIdCache[cacheKey]) return assetRowByRecordIdCache[cacheKey];
    
        var requestPromise = (function () {
          var cached = getAssetRowByRecordId(safeId);
          var cachedHasCoreFields =
            cached &&
            (getValue(cached, ["Type", "ItemType"]) || getValue(cached, ["AssetName", "Title", "Name"]));
          var cachedHasAssetId =
            cached && (extractAssetIdFieldValueOnly(cached) || resolveAssetIdForFormPrefill(cached));
          if (cachedHasCoreFields && cachedHasAssetId) {
            return Promise.resolve(enrichRow(cached));
          }
          return resolveMasterAssetFieldList().then(function (fieldList) {
            return fetchRecordsPage({
              objectName: ASSET_OBJECT,
              objectNames: [ASSET_OBJECT],
              fieldList: fieldList,
              pageNumber: 1,
              pageSize: 1,
              whereClause: "RecordID='" + safeId.replace(/'/g, "''") + "'",
              isAscending: false,
            });
          })
            .then(function (rows) {
              if (rows && rows.length) return enrichRow(rows[0]);
              return cached ? enrichRow(cached) : null;
            })
            .catch(function () {
              return cached ? enrichRow(cached) : null;
            });
        })();
    
        assetRowByRecordIdCache[cacheKey] = requestPromise;
        return requestPromise;
      }
    
      function fetchAssetRowByRecordId(recordId) {
        return fetchAssetRowByRecordIdCached(recordId);
      }
    
      function isDeallocationForm(formConfig) {
        var label = toText(formConfig && (formConfig.formName || formConfig.repositoryName)).toLowerCase();
        return label.indexOf("dealloc") >= 0;
      }
    
      function isAllocationFormConfig(formConfig) {
        var label = toText(formConfig && (formConfig.formName || formConfig.repositoryName)).toLowerCase();
        return label.indexOf("alloc") >= 0 && label.indexOf("dealloc") < 0;
      }
    
      function normalizeFormConfigForOpen(formConfig) {
        formConfig = formConfig || {};
        if (!isDeallocationForm(formConfig)) return formConfig;
        return Object.assign({}, formConfig, {
          formName: "EAsset_Deallocation",
          repositoryName: "EAsset_Deallocation",
          objectId: "",
          viewId: "",
          objectNameCandidates: ["EAsset_Deallocation", "EAsset Deallocation"],
        });
      }
    
      function isExplicitDeallocationLookupKey(lookupKey) {
        var text = toText(lookupKey).toLowerCase();
        if (!text) return false;
        var variants = buildRepositoryNameCandidates("EAsset_Deallocation");
        for (var i = 0; i < variants.length; i += 1) {
          if (variants[i].toLowerCase() === text) return true;
        }
        return false;
      }
    
      function objectMetadataMatchesFormConfig(row, formConfig, lookupKey) {
        if (!row || !formConfig) return true;
        if (isDeallocationForm(formConfig) && isExplicitDeallocationLookupKey(lookupKey)) {
          return Array.isArray(row.Fields) && row.Fields.length > 0 ? true : !!readObjectIdFromMetadataRow(row);
        }
        var objectName = readObjectNameFromMetadataRow(row, lookupKey || "")
          .toLowerCase()
          .replace(/\s+/g, "_");
        if (!objectName) return true;
        if (isDeallocationForm(formConfig)) return objectName.indexOf("dealloc") >= 0;
        if (isAllocationFormConfig(formConfig)) {
          return objectName.indexOf("alloc") >= 0 && objectName.indexOf("dealloc") < 0;
        }
        return true;
      }
    
      function cloneRecordFieldValues(row) {
        var fields = Array.isArray(row && row.RecordFieldValues) ? row.RecordFieldValues : [];
        return fields.map(function (field) {
          var value =
            field.FieldValue != null
              ? field.FieldValue
              : field.UFieldValue != null
                ? field.UFieldValue
                : field.Value != null
                  ? field.Value
                  : "";
          return {
            FieldInternalName: field.FieldInternalName || field.dsNm || field.FieldName,
            FieldName: field.FieldName || field.FieldInternalName || field.dsNm,
            dsNm: field.dsNm || field.FieldInternalName || field.FieldName,
            FieldValue: value,
            Value: value,
            UFieldValue: value,
          };
        });
      }
    
      function upsertRecordFieldValue(list, internalName, value) {
        if (value == null || toText(value) === "") return list;
        var targetKey = normalizeFieldKey(internalName);
        var found = false;
        var next = (list || []).map(function (entry) {
          var entryKey = normalizeFieldKey(entry.FieldInternalName || entry.dsNm || entry.FieldName);
          if (entryKey !== targetKey) return entry;
          found = true;
          return Object.assign({}, entry, {
            FieldInternalName: entry.FieldInternalName || internalName,
            FieldName: entry.FieldName || internalName,
            dsNm: entry.dsNm || internalName,
            FieldValue: value,
            Value: value,
            UFieldValue: value,
          });
        });
        if (!found) {
          next.push({
            FieldInternalName: internalName,
            FieldName: internalName,
            dsNm: internalName,
            FieldValue: value,
            Value: value,
            UFieldValue: value,
          });
        }
        return next;
      }
    
      function buildAssetFormPrefillBundle(row, assetRecordId, formConfig, options) {
        var opts = options || {};
        var context = buildAssetFormContext(row || {}, assetRecordId);
        if (opts.assignedResolved) {
          var assignedResolved = opts.assignedResolved;
          var assignedRaw = toText(assignedResolved.raw);
          var assignedDisplay = toText(assignedResolved.display);
          if (assignedRaw || assignedDisplay) {
            context.assignedToRaw = assignedRaw || assignedDisplay;
            context.assignedTo = assignedDisplay || resolveEmployeeName(assignedRaw) || assignedRaw;
            context.deallocatedFromUser = context.assignedTo;
            context.deallocatedFromRaw = assignedRaw || assignedDisplay;
          }
        }
        var isDeallocate = isDeallocationForm(formConfig);
        var typeValue = context.typeRaw || context.type || "";
        var categoryValue = context.categoryRaw || context.category || "";
        var assetIdValue =
          extractAssetIdFieldValueOnly(row) || resolveAssetIdForFormPrefill(row) || context.assetID || "";
        var deallocatedFromValue = isDeallocate
          ? toText(context.deallocatedFromRaw) ||
            toText(context.assignedToRaw) ||
            toText(context.deallocatedFromUser) ||
            toText(context.assignedTo) ||
            ""
          : toText(context.deallocatedFromUser) || toText(context.assignedToRaw) || toText(context.assignedTo) || "";
    
        var recordFieldValues = cloneRecordFieldValues(row);
        recordFieldValues = upsertRecordFieldValue(recordFieldValues, "Type", typeValue);
        recordFieldValues = upsertRecordFieldValue(recordFieldValues, "Category", categoryValue);
        recordFieldValues = upsertRecordFieldValue(recordFieldValues, "AssetID", assetIdValue);
        if (isDeallocate) {
          recordFieldValues = upsertRecordFieldValue(recordFieldValues, "DeallocatedFromUser", deallocatedFromValue);
          recordFieldValues = upsertRecordFieldValue(recordFieldValues, "DeallocatedFrom", deallocatedFromValue);
        }
    
        var defaultFieldValues = {
          Type: typeValue,
          Category: categoryValue,
          AssetID: assetIdValue,
          type: typeValue,
          category: categoryValue,
          assetID: assetIdValue,
          assetRecordID: context.assetRecordID,
          sourceAssetRecordID: context.sourceAssetRecordID,
        };
        if (isDeallocate) {
          defaultFieldValues.DeallocatedFromUser = deallocatedFromValue;
          defaultFieldValues.DeallocatedFrom = deallocatedFromValue;
          defaultFieldValues.deallocatedFromUser = deallocatedFromValue;
        }
    
        var contextObj = Object.assign({}, context, {
          formName: formConfig.formName || formConfig.repositoryName || "",
          repositoryName: formConfig.repositoryName || "",
          objectID: formConfig.objectId || "",
          mode: opts.mode || "new",
          recordFieldValues: recordFieldValues,
          defaultFieldValues: defaultFieldValues,
        });
        if (opts.newRecordId) {
          contextObj.recordID = toText(opts.newRecordId);
          contextObj.newRecordID = toText(opts.newRecordId);
          defaultFieldValues.recordID = toText(opts.newRecordId);
          defaultFieldValues.RecordID = toText(opts.newRecordId);
        }
    
        return {
          context: context,
          recordFieldValues: recordFieldValues,
          defaultFieldValues: defaultFieldValues,
          contextObj: contextObj,
          isDeallocate: isDeallocate,
        };
      }
    
      function applyAssetFormPrefill(formConfig, bundle, assetRecordId) {
        if (!bundle) return;
        var context = bundle.context || {};
        try {
          var contextPayload = Object.assign(
            { formName: formConfig.formName || formConfig.repositoryName || "" },
            bundle.contextObj || context,
            {
              recordFieldValues: bundle.recordFieldValues || [],
              defaultFieldValues: bundle.defaultFieldValues || {},
              contextObj: bundle.contextObj || context,
            }
          );
          localStorage.setItem("asset_form_prefill_context", JSON.stringify(contextPayload));
          localStorage.setItem("asset_form_prefill_recordFieldValues", JSON.stringify(bundle.recordFieldValues || []));
          localStorage.setItem("asset_form_prefill_defaultFieldValues", JSON.stringify(bundle.defaultFieldValues || {}));
          localStorage.setItem("asset_form_prefill_contextObj", JSON.stringify(bundle.contextObj || {}));
          if (assetRecordId) localStorage.setItem("asset_form_prefill_record_id", toText(assetRecordId));
          localStorage.setItem("asset_form_prefill_type", context.typeRaw || context.type || "");
          localStorage.setItem("asset_form_prefill_category", context.categoryRaw || context.category || "");
          localStorage.setItem("asset_form_prefill_asset_id", context.assetID || "");
          localStorage.setItem("asset_form_prefill_assigned_to", context.assignedToRaw || context.assignedTo || "");
          if (bundle.isDeallocate) {
            localStorage.setItem(
              "asset_form_prefill_deallocated_from",
              context.deallocatedFromUser || context.assignedTo || ""
            );
          }
        } catch (_) {}
      }
    
      function storeAssetPrefill(row, recordId, formConfig) {
        var bundle = buildAssetFormPrefillBundle(row || {}, recordId, formConfig || MASTER_EDIT, { mode: "edit" });
        applyAssetFormPrefill(formConfig || MASTER_EDIT, bundle, recordId);
      }
    
      function buildAssetFormContext(row, assetRecordId) {
        var rawType = getValue(row, ["Type", "ItemType"]);
        var rawCategory = getValue(row, ["Category", "ItemCategory"]);
        var rawAssignedTo = getValue(row, ["AssignedTo", "AssignedToName"]);
        var serial = getValue(row, ["SerialNumber", "SerialNo"]);
        var assetId = resolveAssetIdForFormPrefill(row) || getValue(row, ["AssetID"]) || serial;
        return {
          assetRecordID: toText(assetRecordId),
          sourceAssetRecordID: toText(assetRecordId),
          assetID: displayFieldValue(assetId) || toText(assetId),
          serialNumber: displayFieldValue(serial),
          typeRaw: isBlankDisplayValue(rawType) ? "" : rawType,
          categoryRaw: isBlankDisplayValue(rawCategory) ? "" : rawCategory,
          assignedToRaw: isBlankDisplayValue(rawAssignedTo) ? "" : rawAssignedTo,
          type: displayLookupFieldValue(rawType),
          category: displayLookupFieldValue(rawCategory),
          subCategory: displayLookupFieldValue(getValue(row, ["SubCategory"])),
          deallocatedFromUser: resolveAssignedToDisplay(row),
          assignedTo: resolveAssignedToDisplay(row),
          itemStatus: displayLookupFieldValue(getValue(row, ["ItemStatus", "Status"])),
        };
      }
    
      function resolveAssignedToForForm(row, assetRecordId) {
        var rawFromAsset = getValue(row, ["AssignedTo", "AssignedToName"]);
        var displayFromAsset = resolveAssignedToDisplay(row);
        if (displayFromAsset) {
          return Promise.resolve({
            raw: isBlankDisplayValue(rawFromAsset) ? displayFromAsset : rawFromAsset,
            display: displayFromAsset,
          });
        }
        var safeRecordId = toText(assetRecordId);
        if (!safeRecordId) return Promise.resolve({ raw: "", display: "" });
        var assetIdForLookup =
          getValue(row, ["AssetID", "SerialNumber", "SerialNo"]) || safeRecordId;
        return fetchRecordsPage({
          objectNames: ["EAsset_Allocation"],
          fieldList: "RecordID,AssetID,Employee,AssignedTo,FromDate,ToDate",
          pageNumber: 1,
          pageSize: 1,
          whereClause: "AssetID='" + String(assetIdForLookup).replace(/'/g, "''") + "'",
          isAscending: false,
        })
          .then(function (rows) {
            var latest = Array.isArray(rows) && rows.length ? rows[0] : null;
            if (!latest) return { raw: "", display: "" };
          var employeeRaw = getValue(latest, ["Employee", "AssignedTo"]);
          if (isBlankDisplayValue(employeeRaw)) return { raw: "", display: "" };
          var display = resolveEmployeeName(employeeRaw);
          return { raw: employeeRaw, display: display };
        })
          .catch(function () {
            return { raw: "", display: "" };
          });
      }
    
      function fetchAssetRowForFormPrefill(recordId) {
        return fetchAssetRowByRecordIdCached(recordId);
      }
    
      var fetchAssetRowForDeallocateForm = fetchAssetRowForFormPrefill;
    
      function extractAssetIdFieldValueOnly(row) {
        var enriched = enrichRow(row || {});
        var recordFields = Array.isArray(enriched.RecordFieldValues) ? enriched.RecordFieldValues : [];
        var fi;
        for (fi = 0; fi < recordFields.length; fi += 1) {
          var entry = recordFields[fi];
          var nameKeys = [entry.FieldInternalName, entry.dsNm, entry.FieldName, entry.dn, entry.name];
          var nk;
          for (nk = 0; nk < nameKeys.length; nk += 1) {
            if (normalizeFieldKey(nameKeys[nk]) !== "assetid") continue;
            var formatted = formatAssetIdForFormPrefill(extractRecordFieldEntryValue(entry));
            if (formatted) return formatted;
          }
        }
        var raw = getRawField(enriched, "AssetID");
        if (isBlankDisplayValue(raw) && enriched.AssetID != null) raw = enriched.AssetID;
        if (isBlankDisplayValue(raw) && enriched.__fieldMap && enriched.__fieldMap.assetid != null) {
          raw = enriched.__fieldMap.assetid;
        }
        return formatAssetIdForFormPrefill(raw);
      }
    
      function collectAssetIdLookupCandidates(row, assetRecordId) {
        var enriched = enrichRow(row || {});
        var candidates = [];
        var seen = {};
        function add(value) {
          var text = formatAssetIdForFormPrefill(value);
          if (!text) return;
          var lower = text.toLowerCase();
          if (seen[lower]) return;
          seen[lower] = true;
          candidates.push(text);
        }
        add(resolveAssetIdForFormPrefill(enriched));
        add(getRawField(enriched, "AssetID"));
        add(getRawField(enriched, "SerialNumber"));
        add(getRawField(enriched, "SerialNo"));
        add(getValue(enriched, ["AssetID", "SerialNumber", "SerialNo"]));
        if (toText(assetRecordId)) add(assetRecordId);
        return candidates;
      }
    
      function fetchLatestAllocationEmployee(row, assetRecordId) {
        var candidates = collectAssetIdLookupCandidates(row, assetRecordId);
        var tryIndex = 0;
    
        function tryNext() {
          if (tryIndex >= candidates.length) return Promise.resolve({ raw: "", display: "" });
          var assetKey = candidates[tryIndex];
          tryIndex += 1;
          var safeKey = String(assetKey).replace(/'/g, "''");
          return fetchRecordsPage({
            objectNames: ["EAsset_Allocation"],
            fieldList: "RecordID,AssetID,Employee,AssignedTo,FromDate,ToDate",
            pageNumber: 1,
            pageSize: 1,
            whereClause: "AssetID='" + safeKey + "'",
            isAscending: false,
          }).then(function (rows) {
            var latest = Array.isArray(rows) && rows.length ? rows[0] : null;
            if (!latest) return tryNext();
            var employeeRaw =
              getRawField(latest, "Employee") ||
              getRawField(latest, "AssignedTo") ||
              getValue(latest, ["Employee", "AssignedTo"]);
            if (isBlankDisplayValue(employeeRaw)) return tryNext();
            var display = resolveEmployeeName(employeeRaw) || lookupToText(employeeRaw);
            var raw = fieldValueToText(employeeRaw);
            if (toText(raw).indexOf(";#") < 0) {
              var pair = resolveEmployeeLookupPair(employeeRaw);
              if (pair) raw = pair;
            }
            return { raw: raw || employeeRaw, display: display || lookupToText(employeeRaw) };
          }).catch(function () {
            return tryNext();
          });
        }
    
        return tryNext();
      }
    
      function resolveAssignedToForDeallocateForm(row, assetRecordId) {
        row = enrichRow(row || {});
        var rawCandidates = [
          getRawField(row, "AssignedTo"),
          getRawField(row, "AssignedToName"),
          getValue(row, ["AssignedTo", "AssignedToName"]),
        ];
        var rawFromAsset = "";
        for (var i = 0; i < rawCandidates.length; i += 1) {
          if (!isBlankDisplayValue(rawCandidates[i])) {
            rawFromAsset = rawCandidates[i];
            break;
          }
        }
    
        var assignedIds = extractAssignedToRecordIds(rawFromAsset);
        if (assignedIds.length) {
          var employeeId = assignedIds[0];
          var employeeName =
            resolveEmployeeNameByRecordIdMatch(employeeId, rawFromAsset) ||
            resolveEmployeeName(employeeId) ||
            lookupToText(rawFromAsset);
          var pair = buildLookupPair(employeeId, employeeName);
          return Promise.resolve({
            raw: pair || rawFromAsset,
            display: employeeName || displayLookupFieldValue(rawFromAsset),
          });
        }
    
        if (toText(rawFromAsset).indexOf(";#") >= 0) {
          return Promise.resolve({
            raw: rawFromAsset,
            display: resolveEmployeeName(rawFromAsset) || lookupToText(rawFromAsset),
          });
        }
    
        if (isGuid(toText(rawFromAsset))) {
          var guidName =
            resolveEmployeeNameByRecordIdMatch(rawFromAsset, rawFromAsset) || resolveEmployeeName(rawFromAsset);
          return Promise.resolve({
            raw: buildLookupPair(rawFromAsset, guidName) || rawFromAsset,
            display: guidName,
          });
        }
    
        var displayFromAsset = resolveAssignedToDisplay(row);
        if (!isBlankDisplayValue(rawFromAsset)) {
          return Promise.resolve({
            raw: rawFromAsset,
            display: displayFromAsset || lookupToText(rawFromAsset) || toText(rawFromAsset),
          });
        }
    
        return fetchLatestAllocationEmployee(row, assetRecordId).then(function (allocationResolved) {
          if (allocationResolved && (toText(allocationResolved.raw) || toText(allocationResolved.display))) {
            return allocationResolved;
          }
          if (displayFromAsset) {
            var fallbackPair = resolveEmployeeLookupPair(displayFromAsset);
            return {
              raw: fallbackPair || displayFromAsset,
              display: displayFromAsset,
            };
          }
          return { raw: "", display: "" };
        });
      }
    
      function isDeallocatedFromLikeFieldKey(name) {
        var key = normalizeFieldKey(name);
        return (
          key.indexOf("deallocatedfrom") >= 0 ||
          key.indexOf("deallocatedfromuser") >= 0 ||
          key === "employee"
        );
      }
    
      function finalizeDeallocateSourceDefaults(defaults, row, prefillBundle, enriched, assetRecordId) {
        defaults = defaults || {};
        if (prefillBundle && prefillBundle.defaultFieldValues) {
          Object.assign(defaults, prefillBundle.defaultFieldValues);
        }
        var context = (prefillBundle && prefillBundle.context) || {};
        if (context.typeRaw || context.type) defaults.Type = context.typeRaw || context.type;
        if (context.categoryRaw || context.category) defaults.Category = context.categoryRaw || context.category;
        applyAssetIdDefaults(defaults, enriched || row, context);
        if (context.assetRecordID || assetRecordId) {
          defaults.assetRecordID = context.assetRecordID || assetRecordId;
          defaults.sourceAssetRecordID = context.sourceAssetRecordID || context.assetRecordID || assetRecordId;
        }
    
        var dealloc =
          toText(context.deallocatedFromRaw) ||
          toText(context.assignedToRaw) ||
          toText(defaults.DeallocatedFromUser) ||
          toText(defaults.DeallocatedFrom) ||
          toText(defaults.AssignedTo) ||
          toText(context.deallocatedFromUser) ||
          toText(context.assignedTo);
        if (dealloc) {
          defaults.DeallocatedFromUser = dealloc;
          defaults.DeallocatedFrom = dealloc;
          defaults.Deallocated_From_User = dealloc;
          defaults.deallocatedFromUser = toText(context.deallocatedFromUser) || toText(context.assignedTo) || dealloc;
          defaults.Employee = dealloc;
        }
        return defaults;
      }
    
      /** Field names on allocation/deallocation forms that map to asset row keys. */
      var FORM_FIELD_SOURCE_ALIASES = {
        AssetID: ["Asset_ID", "assetID", "assetId", "Asset Id"],
        Asset_ID: ["AssetID", "assetID", "assetId", "Asset Id"],
        Employee: ["AssignedTo", "AssignedToName"],
        DeallocatedFromUser: [
          "DeallocatedFrom",
          "Deallocated_From_User",
          "DeallocatedFromUser",
          "AssignedTo",
          "AssignedToName",
          "Employee",
        ],
        DeallocatedFrom: [
          "DeallocatedFromUser",
          "Deallocated_From_User",
          "AssignedTo",
          "AssignedToName",
          "Employee",
        ],
        Deallocated_From_User: ["DeallocatedFromUser", "DeallocatedFrom", "AssignedTo", "AssignedToName", "Employee"],
      };
    
      function isAssetIdLikeFieldKey(name) {
        var key = normalizeFieldKey(name);
        if (!key || key === "objectid") return false;
        return key === "assetid" || key === "asset_id" || key === "serialnumber" || key === "serialno";
      }
    
      function isSerialLikeFieldKey(name) {
        var key = normalizeFieldKey(name);
        return key === "serialnumber" || key === "serialno";
      }
    
      function extractRecordFieldEntryValue(field) {
        if (!field || typeof field !== "object") return "";
        var candidates = [
          field.FieldValue,
          field.UFieldValue,
          field.UGFieldValue,
          field.UGFfieldValue,
          field.Value,
          field.fieldValue,
          field.ugFieldValue,
          field.value,
        ];
        for (var i = 0; i < candidates.length; i += 1) {
          if (candidates[i] != null && candidates[i] !== "") return candidates[i];
        }
        return "";
      }
    
      function formatAssetIdForFormPrefill(value) {
        if (isBlankDisplayValue(value)) return "";
        if (typeof value === "object") {
          var fromObj = fieldValueToText(value);
          if (!isBlankDisplayValue(fromObj)) return fromObj;
          if (value.AssetID != null) return formatAssetIdForFormPrefill(value.AssetID);
          if (value.Value != null) return formatAssetIdForFormPrefill(value.Value);
          return "";
        }
        var text = fieldValueToText(value);
        if (isBlankDisplayValue(text)) text = toText(value);
        if (isBlankDisplayValue(text)) return "";
        if (text.indexOf(";#") >= 0) return lookupToText(text);
        return text;
      }
    
      function scanRowForAssetIdValue(row) {
        var enriched = enrichRow(row || {});
        var foundAssetId = "";
        var foundSerial = "";
    
        function consider(value, isSerial) {
          var formatted = formatAssetIdForFormPrefill(value);
          if (!formatted) return;
          if (isSerial) {
            if (!foundSerial) foundSerial = formatted;
          } else if (!foundAssetId) {
            foundAssetId = formatted;
          }
        }
    
        function inspectNameAndValue(name, value) {
          if (!isAssetIdLikeFieldKey(name)) return;
          consider(value, isSerialLikeFieldKey(name));
        }
    
        if (enriched && typeof enriched === "object") {
          Object.keys(enriched).forEach(function (key) {
            if (key === "__fieldMap" || key === "RecordFieldValues") return;
            inspectNameAndValue(key, enriched[key]);
          });
        }
    
        if (enriched.__fieldMap) {
          Object.keys(enriched.__fieldMap).forEach(function (key) {
            inspectNameAndValue(key, enriched.__fieldMap[key]);
          });
        }
    
        var recordFields = Array.isArray(enriched.RecordFieldValues) ? enriched.RecordFieldValues : [];
        recordFields.forEach(function (field) {
          var names = [
            field.FieldInternalName,
            field.dsNm,
            field.dn,
            field.FieldName,
            field.DisplayName,
            field.name,
          ];
          var value = extractRecordFieldEntryValue(field);
          for (var n = 0; n < names.length; n += 1) {
            inspectNameAndValue(names[n], value);
          }
        });
    
        return foundAssetId || foundSerial || "";
      }
    
      function resolveAssetIdForFormPrefill(row) {
        var fromAssetIdField = extractAssetIdFieldValueOnly(row);
        if (fromAssetIdField) return fromAssetIdField;
        return scanRowForAssetIdValue(row);
      }
    
      function applyAssetIdDefaults(defaults, row, context) {
        var assetRecordId =
          (context && (context.assetRecordID || context.sourceAssetRecordID)) ||
          defaults.assetRecordID ||
          defaults.sourceAssetRecordID ||
          "";
        var lookupPair = buildAssetMasterLookupPairFromRow(row, assetRecordId, null);
        var assetIdValue =
          lookupPair ||
          extractAssetIdFieldValueOnly(row) ||
          resolveAssetIdForFormPrefill(row) ||
          formatAssetIdForFormPrefill(context && context.assetID);
        if (!assetIdValue) return defaults;
        defaults.AssetID = assetIdValue;
        return defaults;
      }
    
      function isFormAssetIdInternalName(fieldName) {
        return normalizeFieldKey(fieldName) === "assetid";
      }
    
      function isAssetMasterLookupObject(lookupObject) {
        var name = toText(lookupObject).toLowerCase().replace(/\s+/g, "_");
        return (
          name === "easset_master" ||
          name === "asset_master" ||
          name.indexOf("easset_master") >= 0
        );
      }
    
      function isAssetIdFormLookupField(field) {
        if (!field) return false;
        if (isFormAssetIdInternalName(getFormFieldInternalName(field))) return true;
        return isSchemaLookupField(field) && isAssetMasterLookupObject(getSchemaLookupObjectName(field));
      }
    
      /** Allocation form AssetID LUP ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ EAsset_Master; display field is usually SerialNumber. */
      function buildAssetMasterLookupPairFromRow(row, assetRecordId, field) {
        var enriched = enrichRow(row || {});
        var recordId =
          toText(assetRecordId) ||
          getValue(enriched, ["RecordID", "RecordId", "recordID", "ID", "Id"]);
        var rawAssetId = getRawField(enriched, "AssetID") || getValue(enriched, ["AssetID"]);
        if (!recordId && rawAssetId && toText(rawAssetId).indexOf(";#") >= 0) {
          recordId = lookupId(rawAssetId);
        }
        var displayField = field ? getSchemaLookupDisplayField(field) : "SerialNumber";
        var label = "";
        if (displayField) {
          label =
            lookupToText(getRawField(enriched, displayField)) ||
            getValue(enriched, [displayField]) ||
            lookupToText(getValue(enriched, [displayField]));
        }
        if (!label) {
          label =
            getValue(enriched, ["SerialNumber", "SerialNo"]) ||
            formatAssetIdForFormPrefill(rawAssetId) ||
            resolveAssetIdForFormPrefill(enriched);
        }
        if (!recordId && !label) return "";
        if (recordId && label) return buildLookupPair(recordId, label);
        if (recordId) return buildLookupPair(recordId, label || recordId);
        return label;
      }
    
      function normalizeAssetIdLookupPairForForm(rawValue, assetRow, assetRecordId, field) {
        if (!isBlankDisplayValue(rawValue)) {
          var text = fieldValueToText(rawValue);
          if (text.indexOf(";#") >= 0) {
            var pairId = lookupId(text);
            var pairLabel = lookupToText(text);
            if (pairId && pairLabel) return buildLookupPair(pairId, pairLabel);
            if (pairId && isGuid(pairId)) {
              var labelFromRow = buildAssetMasterLookupPairFromRow(assetRow, assetRecordId, field);
              if (labelFromRow) return labelFromRow;
              return buildLookupPair(pairId, pairLabel || pairId);
            }
          }
          if (isGuid(text)) {
            var guidPair = buildAssetMasterLookupPairFromRow(assetRow, assetRecordId, field);
            if (guidPair && lookupId(guidPair) === text) return guidPair;
            return buildLookupPair(text, lookupToText(text) || text);
          }
        }
        return buildAssetMasterLookupPairFromRow(assetRow, assetRecordId, field);
      }
    
      async function resolveAssetIdFieldForForm(field, rawDefault, assetRow, assetRecordId, pageSize) {
        var fromRow = normalizeAssetIdLookupPairForForm(rawDefault, assetRow, assetRecordId, field);
        if (fromRow && fromRow.indexOf(";#") >= 0 && isGuid(lookupId(fromRow))) return fromRow;
        if (isSchemaLookupField(field)) {
          var lookupResolved = await resolveSchemaLookupFieldValue(field, rawDefault, pageSize);
          if (!isBlankDisplayValue(lookupResolved)) return lookupResolved;
        }
        return fromRow || formatAssetIdForFormPrefill(rawDefault);
      }
    
      function enforceAssetIdOnShowFields(showFieldsWithValue, assetRow, assetRecordId) {
        if (!Array.isArray(showFieldsWithValue) || !showFieldsWithValue.length) return;
        var assetIdValue = buildAssetMasterLookupPairFromRow(assetRow, assetRecordId, null);
        if (!assetIdValue) {
          assetIdValue = normalizeAssetIdLookupPairForForm(
            extractAssetIdFieldValueOnly(assetRow) || resolveAssetIdForFormPrefill(assetRow),
            assetRow,
            assetRecordId,
            null
          );
        }
        if (!assetIdValue) return;
        for (var i = 0; i < showFieldsWithValue.length; i += 1) {
          if (!isFormAssetIdInternalName(showFieldsWithValue[i].fieldName)) continue;
          showFieldsWithValue[i].fieldValue = assetIdValue;
        }
      }
    
      function findHostService(name) {
        try {
          if (window[name]) return window[name];
          if (window.parent && window.parent[name]) return window.parent[name];
          if (window.top && window.top[name]) return window.top[name];
        } catch (_) {}
        return null;
      }
    
      function extractFirstApiRow(payload) {
        if (!payload || typeof payload !== "object") return null;
        if (Array.isArray(payload)) return payload[0] || null;
        if (Array.isArray(payload.Items)) return payload.Items[0] || null;
        if (Array.isArray(payload.Data)) return payload.Data[0] || null;
        if (Array.isArray(payload.data)) return payload.data[0] || null;
        var nested = payload.object || payload.Object || payload.result || payload.Result;
        if (Array.isArray(nested)) return nested[0] || null;
        if (nested && typeof nested === "object") return nested;
        return payload;
      }
    
      function buildRepositoryNameCandidates(name) {
        var raw = toText(name);
        if (!raw) return [];
        var variants = [
          raw,
          raw.replace(/\s+/g, "_"),
          raw.replace(/_/g, " "),
          raw.replace(/\s+/g, ""),
        ];
        var unique = [];
        var seen = {};
        for (var i = 0; i < variants.length; i += 1) {
          var candidate = toText(variants[i]);
          if (!candidate) continue;
          var lower = candidate.toLowerCase();
          if (seen[lower]) continue;
          seen[lower] = true;
          unique.push(candidate);
        }
        return unique;
      }
    
      function collectFormNameSeeds(formConfig) {
        var seeds = [];
        var cfg = formConfig || {};
        function add(value) {
          var text = toText(value);
          if (!text) return;
          var lower = text.toLowerCase();
          for (var i = 0; i < seeds.length; i += 1) {
            if (seeds[i].toLowerCase() === lower) return;
          }
          seeds.push(text);
        }
        if (isDeallocationForm(cfg)) {
          add("EAsset_Deallocation");
          add("EAsset Deallocation");
          add(cfg.repositoryName);
          add(cfg.formName);
          if (Array.isArray(cfg.objectNameCandidates)) {
            cfg.objectNameCandidates.forEach(add);
          }
          buildRepositoryNameCandidates("EAsset_Deallocation").forEach(add);
          return seeds;
        }
        add(cfg.repositoryName);
        add(cfg.formName);
        add(cfg.objectId);
        if (Array.isArray(cfg.objectNameCandidates)) {
          cfg.objectNameCandidates.forEach(add);
        }
        buildRepositoryNameCandidates(cfg.repositoryName || cfg.formName).forEach(add);
        return seeds;
      }
    
      function getFormConfigCacheKey(formConfig) {
        var prefix = isDeallocationForm(formConfig)
          ? "deallocation"
          : isAllocationFormConfig(formConfig)
            ? "allocation"
            : "form";
        return prefix + ":" + collectFormNameSeeds(formConfig).join("|").toLowerCase();
      }
    
      function readObjectIdFromMetadataRow(row) {
        if (!row || typeof row !== "object") return "";
        return toText(row.ObjectID || row.ObjectId || row.objectID || row.objectId || row.ID || row.Id);
      }
    
      function readObjectNameFromMetadataRow(row, fallback) {
        if (!row || typeof row !== "object") return toText(fallback);
        return toText(
          row.ObjectName ||
            row.objectName ||
            row.RepositoryName ||
            row.repositoryName ||
            row.Name ||
            row.InternalName ||
            fallback
        );
      }
    
      async function resolveObjectIdFromRepository(input, formConfig) {
        formConfig = formConfig || {};
        var primaryKey = getPrimaryRepositoryLookupKey(formConfig) || toText(formConfig.repositoryName || formConfig.formName);
        var configuredObjectId = toText(formConfig.objectId);
        var lookupKey = toText(input) || primaryKey || (isGuid(configuredObjectId) ? configuredObjectId : "");
        if (!lookupKey) {
          return { objectId: "", objectName: "", objectRow: null };
        }
    
        // If both a name-based key and a UUID objectId are configured, pre-register
        // the UUID in the cache with the same in-flight promise before awaiting.
        // This prevents a second ObjectGet HTTP request when the name lookup's row
        // fails objectMetadataMatchesFormConfig and the fallback tries the UUID ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â
        // by then the promise is already cached and no new fetch is made.
        var namePromise = fetchObjectMetadataOnce(lookupKey);
        if (
          isGuid(configuredObjectId) &&
          configuredObjectId.toLowerCase() !== lookupKey.toLowerCase() &&
          !objectMetadataByKeyCache[configuredObjectId.toLowerCase()]
        ) {
          objectMetadataByKeyCache[configuredObjectId.toLowerCase()] = namePromise;
        }
    
        var row = await namePromise;
        if (row && !objectMetadataMatchesFormConfig(row, formConfig, lookupKey)) {
          row = null;
        }
    
        if (
          !row &&
          isGuid(configuredObjectId) &&
          configuredObjectId.toLowerCase() !== lookupKey.toLowerCase()
        ) {
          row = await fetchObjectMetadataOnce(configuredObjectId);
          if (row) lookupKey = configuredObjectId;
        }
    
        if (!row) {
          return { objectId: "", objectName: toText(lookupKey) || "", objectRow: null };
        }
    
        var objectId = readObjectIdFromMetadataRow(row);
        if (!objectId && isGuid(lookupKey)) objectId = lookupKey;
        return {
          objectId: objectId,
          objectName: readObjectNameFromMetadataRow(row, primaryKey || lookupKey),
          objectRow: row,
        };
      }
    
      async function resolveViewIdFromObjectId(objectId) {
        return fetchViewIdOnce(objectId);
      }
    
      async function resolveFormConfigInternal(formConfig) {
        formConfig = normalizeFormConfigForOpen(formConfig || {});
        var cacheKey = getFormConfigCacheKey(formConfig);
        if (cacheKey && resolvedFormConfigCache[cacheKey]) {
          var cachedConfig = resolvedFormConfigCache[cacheKey];
          var cachedUsable =
            !isDeallocationForm(formConfig) ||
            (toText(cachedConfig.objectId) &&
              ((cachedConfig.objectRow && Array.isArray(cachedConfig.objectRow.Fields) && cachedConfig.objectRow.Fields.length) ||
                true));
          if (cachedUsable) {
            return Object.assign({}, formConfig, cachedConfig);
          }
          delete resolvedFormConfigCache[cacheKey];
        }
    
        var objectResolution = await resolveObjectIdFromRepository("", formConfig);
        var resolvedObjectId = toText(objectResolution && objectResolution.objectId);
        var resolvedObjectName =
          toText(objectResolution && objectResolution.objectName) ||
          toText(formConfig.repositoryName || formConfig.formName);
        var objectRow = (objectResolution && objectResolution.objectRow) || null;
    
        var resolvedViewId = toText(formConfig.viewId);
        if (!resolvedViewId && resolvedObjectId) {
          resolvedViewId = await fetchViewIdOnce(resolvedObjectId);
        }
    
        var canonicalName = isDeallocationForm(formConfig)
          ? "EAsset_Deallocation"
          : isAllocationFormConfig(formConfig)
            ? "EAsset_Allocation"
            : toText(resolvedObjectName || formConfig.repositoryName || formConfig.formName);
        if (canonicalName.indexOf(" ") >= 0) {
          canonicalName = canonicalName.replace(/\s+/g, "_");
        }
    
        var resolvedPatch = {
          objectId: resolvedObjectId,
          viewId: resolvedViewId,
          repositoryName: canonicalName || formConfig.repositoryName || formConfig.formName,
          formName: isDeallocationForm(formConfig)
            ? "EAsset_Deallocation"
            : isAllocationFormConfig(formConfig)
              ? "EAsset_Allocation"
              : formConfig.formName || canonicalName,
          objectNameCandidates: formConfig.objectNameCandidates,
          objectRow: objectRow,
        };
    
        if (cacheKey) resolvedFormConfigCache[cacheKey] = resolvedPatch;
        return Object.assign({}, formConfig, resolvedPatch);
      }
    
      function resolveFormConfig(formConfig) {
        formConfig = normalizeFormConfigForOpen(formConfig || {});
        var cacheKey = getFormConfigCacheKey(formConfig);
        if (cacheKey && resolvedFormConfigCache[cacheKey]) {
          var cached = resolvedFormConfigCache[cacheKey];
          // Treat any resolved cache entry as usable ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â consistent with resolveFormConfigInternal.
          // This prevents a repeat ObjectGet + ViewGet when the cached objectRow lacks Fields.
          if (cached) {
            return Promise.resolve(Object.assign({}, formConfig, cached));
          }
        }
        if (cacheKey && inflightResolveFormConfig[cacheKey]) {
          return inflightResolveFormConfig[cacheKey].then(function (resolved) {
            return Object.assign({}, formConfig, resolved);
          });
        }
        var promise = resolveFormConfigInternal(formConfig);
        if (cacheKey) {
          inflightResolveFormConfig[cacheKey] = promise;
          promise = promise.finally(function () {
            delete inflightResolveFormConfig[cacheKey];
          });
        }
        return promise;
      }
    
      async function getObjectFieldsById(objectIdOrName, resolvedForm) {
        if (!toText(objectIdOrName)) throw new Error("objectId or repository name is required");
        if (
          resolvedForm &&
          resolvedForm.objectRow &&
          Array.isArray(resolvedForm.objectRow.Fields) &&
          resolvedForm.objectRow.Fields.length
        ) {
          return resolvedForm.objectRow;
        }
        var lookupKey = toText((resolvedForm && resolvedForm.objectId) || objectIdOrName);
        var row = await fetchObjectMetadataOnce(lookupKey);
        if (row) return row;
        throw new Error("Could not load object schema for " + lookupKey);
      }
    
      function parseLookupObjectField(value) {
        if (!value) return null;
        var parts = String(value).split(";#");
        return parts.length > 1 ? parts[1] : parts[0];
      }
    
      function getFormFieldInternalName(field) {
        return field && field.InternalName;
      }
    
      function isSchemaLookupField(field) {
        return !!(field && String(field.DataType || "").toUpperCase() === "LUP");
      }
    
      function getSchemaLookupObjectName(field) {
        return field && parseLookupObjectField(field.LookupObject);
      }
    
      function getSchemaLookupDisplayField(field) {
        var raw = field && field.LookupObjectField1;
        if (!raw) return "RecordID";
        var parts = String(raw).split(";#");
        return parts.length > 1 ? parts[1] : parts[0];
      }
    
      function buildLookupPair(id, label) {
        var safeId = toText(id);
        var safeLabel = toText(label);
        if (!safeId && !safeLabel) return "";
        if (safeId && safeLabel) return safeId + ";#" + safeLabel;
        return safeId || safeLabel;
      }
    
      function findDefaultForField(defaults, fieldName) {
        if (!defaults || !fieldName) return "";
        if (defaults[fieldName] != null && toText(defaults[fieldName]) !== "") return defaults[fieldName];
        var lower = String(fieldName).toLowerCase();
        var keys = Object.keys(defaults);
        for (var i = 0; i < keys.length; i += 1) {
          if (String(keys[i]).toLowerCase() === lower && toText(defaults[keys[i]]) !== "") {
            return defaults[keys[i]];
          }
        }
        var aliases = FORM_FIELD_SOURCE_ALIASES[fieldName];
        if (aliases) {
          for (var a = 0; a < aliases.length; a += 1) {
            var aliasVal = findDefaultForField(defaults, aliases[a]);
            if (aliasVal != null && toText(aliasVal) !== "") return aliasVal;
          }
        }
        return "";
      }
    
      function resolveEmployeeLookupPair(rawValue) {
        if (isBlankDisplayValue(rawValue)) return "";
        var text = fieldValueToText(rawValue);
        if (text.indexOf(";#") >= 0) {
          var id = lookupId(text);
          var label = lookupToText(text);
          if (id && !label && isGuid(id)) {
            label = resolveEmployeeNameByRecordIdMatch(id, rawValue) || displayLookupFieldValue(text);
          }
          return buildLookupPair(id, label);
        }
        var ids = extractAssignedToRecordIds(rawValue);
        if (ids.length) {
          var recordId = ids[0];
          var name =
            resolveEmployeeNameByRecordIdMatch(recordId, rawValue) ||
            resolveEmployeeName(recordId) ||
            lookupToText(rawValue);
          return buildLookupPair(recordId, name);
        }
        if (isGuid(text)) {
          var resolvedName = resolveEmployeeName(text) || resolveEmployeeNameByRecordIdMatch(text, rawValue);
          return buildLookupPair(text, resolvedName);
        }
        var options = state.employeeOptions || [];
        for (var i = 0; i < options.length; i += 1) {
          var opt = options[i];
          if (!opt) continue;
          if (toText(opt.label).toLowerCase() === text.toLowerCase()) {
            return buildLookupPair(opt.value || opt.id, opt.label);
          }
        }
        return text;
      }
    
      function isEmployeeLookupObject(lookupObject) {
        var name = toText(lookupObject).toLowerCase();
        return name.indexOf("employee") >= 0 || name.indexOf("user") >= 0;
      }
    
      function resolveAssignLookupPrefillValue(field, rawValue) {
        if (isBlankDisplayValue(rawValue)) return "";
        if (isEmployeeLookupObject(getSchemaLookupObjectName(field))) {
          return resolveEmployeeLookupPair(rawValue);
        }
        var text = fieldValueToText(rawValue);
        if (!text) return "";
        if (text.indexOf(";#") >= 0) {
          var pairId = lookupId(text);
          var pairLabel = lookupToText(text);
          if (pairId && pairLabel) return buildLookupPair(pairId, pairLabel);
          return text;
        }
        if (isGuid(text)) {
          return buildLookupPair(text, lookupToText(text) || text);
        }
        return text;
      }
    
      async function resolveSchemaLookupFieldValue(field, rawValue, pageSize) {
        if (isBlankDisplayValue(rawValue)) return "";
        var lookupObject = getSchemaLookupObjectName(field);
        if (lookupObject && isEmployeeLookupObject(lookupObject)) {
          return resolveEmployeeLookupPair(rawValue);
        }
        var text = fieldValueToText(rawValue);
        if (!text) return "";
        if (text.indexOf(";#") >= 0) {
          var pairId = lookupId(text);
          var pairLabel = lookupToText(text);
          if (pairId && pairLabel) return buildLookupPair(pairId, pairLabel);
          if (pairId && isGuid(pairId) && lookupObject) {
            var displayField = getSchemaLookupDisplayField(field);
            var whereId = "RecordID='" + String(pairId).replace(/'/g, "''") + "'";
            var byIdRows = await fetchRecordsPage({
              objectNames: [lookupObject],
              fieldList: "RecordID," + displayField,
              pageSize: 1,
              pageNumber: 1,
              whereClause: whereId,
              isAscending: true,
            });
            if (byIdRows.length) {
              var row = byIdRows[0];
              var fetchedLabel = getValue(row, [displayField]) || lookupToText(getRawField(row, displayField));
              return buildLookupPair(pairId, fetchedLabel || pairLabel);
            }
          }
          return text;
        }
        if (isGuid(text) && lookupObject) {
          var displayFieldName = getSchemaLookupDisplayField(field);
          var whereGuid = "RecordID='" + String(text).replace(/'/g, "''") + "'";
          var guidRows = await fetchRecordsPage({
            objectNames: [lookupObject],
            fieldList: "RecordID," + displayFieldName,
            pageSize: 1,
            pageNumber: 1,
            whereClause: whereGuid,
            isAscending: true,
          });
          if (guidRows.length) {
            var match = guidRows[0];
            var label = getValue(match, [displayFieldName]) || lookupToText(getRawField(match, displayFieldName));
            return buildLookupPair(text, label);
          }
          return text;
        }
        if (lookupObject) {
          var displayFieldKey = getSchemaLookupDisplayField(field);
          var safeLabel = String(text).replace(/'/g, "''");
          var whereLabel = displayFieldKey + "='" + safeLabel + "'";
          var labelRows = await fetchRecordsPage({
            objectNames: [lookupObject],
            fieldList: "RecordID," + displayFieldKey,
            pageSize: pageSize || 25,
            pageNumber: 1,
            whereClause: whereLabel,
            isAscending: true,
          });
          if (labelRows.length) {
            var hit = labelRows[0];
            var hitId = getValue(hit, ["RecordID"]) || lookupId(getRawField(hit, "RecordID"));
            var hitLabel = getValue(hit, [displayFieldKey]) || text;
            return buildLookupPair(hitId, hitLabel);
          }
        }
        return text;
      }
    
      function formatSchemaFieldValue(field, rawValue) {
        if (isBlankDisplayValue(rawValue)) return "";
        if (isSchemaLookupField(field)) return fieldValueToText(rawValue);
        return fieldValueToText(rawValue);
      }
    
      function buildSourceDefaultsFromAssetRow(row, prefillBundle, formConfig, assetRecordId) {
        var defaults = Object.assign({}, (prefillBundle && prefillBundle.defaultFieldValues) || {});
        if (isDeallocationForm(formConfig) && prefillBundle && prefillBundle.defaultFieldValues) {
          Object.assign(defaults, prefillBundle.defaultFieldValues);
        }
        var context = (prefillBundle && prefillBundle.context) || {};
        var enriched = enrichRow(row || {});
    
        function put(name, keys) {
          var keyList = Array.isArray(keys) ? keys : [keys];
          var raw = "";
          for (var i = 0; i < keyList.length; i += 1) {
            raw = getRawField(enriched, keyList[i]);
            if (raw != null && raw !== "") break;
            raw = getValue(enriched, keyList);
            if (raw) break;
          }
          if (raw != null && toText(raw) !== "") defaults[name] = raw;
        }
    
        put("Type", ["Type", "ItemType"]);
        put("Category", ["Category", "ItemCategory"]);
        put("SubCategory", ["SubCategory"]);
        put("AssetID", ["AssetID", "SerialNumber", "SerialNo"]);
        put("AssetName", ["AssetName", "Title", "Name"]);
        put("SerialNumber", ["SerialNumber", "SerialNo"]);
        put("ItemStatus", ["ItemStatus", "Status"]);
        put("Location", ["Location"]);
        put("Department", ["Department"]);
        put("AssetManager", ["AssetManager"]);
        put("AssignedTo", ["AssignedTo", "AssignedToName"]);
        put("ReceivedOn", ["ReceivedOn", "ReceivedDate"]);
    
        if (context.typeRaw || context.type) defaults.Type = context.typeRaw || context.type;
        if (context.categoryRaw || context.category) defaults.Category = context.categoryRaw || context.category;
        applyAssetIdDefaults(defaults, enriched, context);
        if (context.assetRecordID || assetRecordId) {
          defaults.assetRecordID = context.assetRecordID || assetRecordId;
          defaults.sourceAssetRecordID = context.sourceAssetRecordID || context.assetRecordID || assetRecordId;
        }
        if (context.assignedToRaw || context.assignedTo) {
          defaults.AssignedTo = context.assignedToRaw || context.assignedTo;
        }
    
        if (isDeallocationForm(formConfig)) {
          var dealloc =
            toText(context.deallocatedFromRaw) ||
            toText(context.assignedToRaw) ||
            toText(defaults.DeallocatedFromUser) ||
            toText(defaults.DeallocatedFrom) ||
            toText(defaults.AssignedTo) ||
            toText(context.deallocatedFromUser) ||
            toText(context.assignedTo);
          if (dealloc) {
            defaults.DeallocatedFromUser = dealloc;
            defaults.DeallocatedFrom = dealloc;
            defaults.deallocatedFromUser =
              toText(context.deallocatedFromUser) || toText(context.assignedTo) || dealloc;
          }
        }
    
        var recordFieldValues = (prefillBundle && prefillBundle.recordFieldValues) || [];
        var resolvedAssetId = extractAssetIdFieldValueOnly(enriched) || resolveAssetIdForFormPrefill(enriched);
        recordFieldValues.forEach(function (entry) {
          var internalName = entry.FieldInternalName || entry.dsNm || entry.FieldName;
          if (!internalName) return;
          if (isFormAssetIdInternalName(internalName)) {
            if (resolvedAssetId) defaults.AssetID = resolvedAssetId;
            return;
          }
          var value =
            entry.FieldValue != null
              ? entry.FieldValue
              : entry.UFieldValue != null
                ? entry.UFieldValue
                : extractRecordFieldEntryValue(entry);
          if (value == null || toText(value) === "") return;
          defaults[internalName] = value;
        });
    
        applyAssetIdDefaults(defaults, enriched, context);
        if (isDeallocationForm(formConfig)) {
          finalizeDeallocateSourceDefaults(defaults, row, prefillBundle, enriched, assetRecordId);
        }
    
        return defaults;
      }
    
      function mergeDefaultsIntoShowFields(showFieldsWithValue, defaults, mergeOptions) {
        if (!defaults || typeof defaults !== "object") return;
        var opts = mergeOptions || {};
        var forceAll = !!opts.forceAll;
        if (opts.useFieldAliases) {
          for (var si = 0; si < showFieldsWithValue.length; si += 1) {
            var fieldName = showFieldsWithValue[si].fieldName;
            if (!fieldName) continue;
            var aliasValue = findDefaultForField(defaults, fieldName);
            if (aliasValue == null || toText(aliasValue) === "") continue;
            if (
              forceAll ||
              showFieldsWithValue[si].fieldValue == null ||
              toText(showFieldsWithValue[si].fieldValue) === ""
            ) {
              showFieldsWithValue[si].fieldValue = aliasValue;
            }
          }
          return;
        }
        Object.keys(defaults).forEach(function (key) {
          if (defaults[key] === undefined || defaults[key] === null || toText(defaults[key]) === "") return;
          for (var si = 0; si < showFieldsWithValue.length; si += 1) {
            try {
              if (String(showFieldsWithValue[si].fieldName).toLowerCase() !== String(key).toLowerCase()) continue;
              if (
                !forceAll &&
                showFieldsWithValue[si].fieldValue != null &&
                toText(showFieldsWithValue[si].fieldValue) !== ""
              ) {
                break;
              }
              showFieldsWithValue[si].fieldValue = defaults[key];
              break;
            } catch (_) {}
          }
        });
      }
    
      async function loadFormSchemaForOpen(resolvedForm) {
        var resolved = resolvedForm || {};
        var row = resolved.objectRow;
        if (row && Array.isArray(row.Fields) && row.Fields.length) return row;
        if (Array.isArray(row) && row[0] && Array.isArray(row[0].Fields) && row[0].Fields.length) return row[0];
    
        var lookupKey = toText(resolved.objectId) || getPrimaryRepositoryLookupKey(resolved);
        if (!lookupKey) return row || {};
        if (!row) {
          row = await fetchObjectMetadataOnce(lookupKey);
          if (row) {
            resolved.objectRow = row;
            var cacheKey = getFormConfigCacheKey(resolved);
            if (cacheKey && resolvedFormConfigCache[cacheKey]) {
              resolvedFormConfigCache[cacheKey].objectRow = row;
            }
          }
        }
        return row || {};
      }
    
      function cloneShowFieldsWithValue(list) {
        return (list || []).map(function (entry) {
          return { fieldName: entry.fieldName, fieldValue: entry.fieldValue };
        });
      }
    
      function buildPopulateOptionsForOpen(mergeOptions, defaults) {
        var opts = mergeOptions || {};
        var defs = defaults || {};
        return {
          isDeallocate: !!opts.forceAll,
          assetRow: opts.assetRow,
          assetRecordId:
            toText(defs.assetRecordID) ||
            toText(defs.sourceAssetRecordID) ||
            toText(opts.assetRecordId) ||
            "",
        };
      }
    
      async function buildShowFieldsWithValuesForOpen(resolvedForm, defaults, pageSize, mergeOptions) {
        var opts = mergeOptions || {};
        if (resolvedForm && resolvedForm._cachedShowFieldsWithValue) {
          // Cache holds only field name structure (values are undefined). We still
          // need to resolve values via populateShowFieldsFromRecord so that lookup
          // fields go through resolveSchemaLookupFieldValue (cached via fetchRecordsPageCache).
          var reused = cloneShowFieldsWithValue(resolvedForm._cachedShowFieldsWithValue);
          applyAssetIdDefaults(defaults, opts.assetRow, null);
          var cachedSchemaObj = resolvedForm.objectRow || {};
          var cachedFields = Array.isArray(cachedSchemaObj.Fields) ? cachedSchemaObj.Fields : [];
          if (cachedFields.length) {
            await populateShowFieldsFromRecord(cachedFields, reused, defaults, pageSize, buildPopulateOptionsForOpen(opts, defaults));
          }
          mergeDefaultsIntoShowFields(
            reused,
            defaults,
            Object.assign({ useFieldAliases: !!opts.forceAll }, opts)
          );
          enforceAssetIdOnShowFields(
            reused,
            opts.assetRow,
            toText(defaults.assetRecordID) || toText(defaults.sourceAssetRecordID) || toText(opts.assetRecordId)
          );
          return reused;
        }
        var schemaObj = await loadFormSchemaForOpen(resolvedForm);
        var fields = schemaObj.Fields || [];
        var showFieldsWithValue = fields.map(function (f) {
          return { fieldName: f.InternalName, fieldValue: undefined };
        });
        applyAssetIdDefaults(defaults, opts.assetRow, null);
        var populateOptions = buildPopulateOptionsForOpen(opts, defaults);
        await populateShowFieldsFromRecord(fields, showFieldsWithValue, defaults, pageSize, populateOptions);
        mergeDefaultsIntoShowFields(
          showFieldsWithValue,
          defaults,
          Object.assign({ useFieldAliases: !!opts.forceAll }, opts)
        );
        enforceAssetIdOnShowFields(
          showFieldsWithValue,
          opts.assetRow,
          populateOptions.assetRecordId
        );
        if (resolvedForm) {
          // Cache only the field name structure (values cleared) so that each form
          // open re-resolves values from the current asset's defaults via
          // populateShowFieldsFromRecord. Caching resolved values caused stale data
          // from a previous open to persist and blocked correct autopopulation.
          // Schema re-fetch is still prevented by fetchObjectMetadataOnce cache;
          // lookup resolution re-fetches are prevented by fetchRecordsPageCache.
          resolvedForm._cachedShowFieldsWithValue = showFieldsWithValue.map(function (entry) {
            return { fieldName: entry.fieldName, fieldValue: undefined };
          });
        }
        return showFieldsWithValue;
      }
    
      function invokeAddItemWithShowFields(resolvedForm, showFieldsWithValue, opts) {
        var qafPage = findHostService("QafPageService");
        if (!qafPage || typeof qafPage.AddItem !== "function") return false;
        var target =
          toText(resolvedForm && resolvedForm.objectId) ||
          getPrimaryRepositoryLookupKey(resolvedForm) ||
          toText(resolvedForm && resolvedForm.repositoryName);
        if (!target) return false;
        opts = opts || {};
        var inventoryStyleRefresh = function inventoryStyleRefresh() {
          if (typeof window.qafAssetDetailsLoadAfterSave === "function") {
            window.qafAssetDetailsLoadAfterSave();
            return;
          }
          reloadAfterSave();
        };
        var saveRefresh =
          typeof opts.onSaveAction === "function"
            ? opts.onSaveAction
            : typeof opts.callback === "function"
              ? opts.callback
              : inventoryStyleRefresh;
        var callback = typeof opts.callback === "function" ? opts.callback : saveRefresh;
        try {
          var addArgs = [
            target,
            callback,
            opts.showFields || undefined,
            showFieldsWithValue,
            opts.fieldFilterConditions || undefined,
            opts.fieldConversion || undefined,
            opts.hiddenFields || opts.hiddenFieldsForm || undefined,
            opts.excludeFieldFromForm || undefined,
            saveRefresh,
            opts.changeTitles || undefined,
            typeof opts.openAsPopup === "boolean" ? opts.openAsPopup : false,
            opts.addUpdateApi || undefined,
            opts.readOnlyFormField || undefined,
            opts.whereclauseForRecordID || undefined,
            opts.requiredFormField || undefined,
            opts.uFieldID || undefined,
          ];
          qafPage.AddItem.apply(qafPage, addArgs);
          return { openedBy: "QafPageService.AddItem", target: target };
        } catch (_) {
          return false;
        }
      }
    
      async function resolveDeallocateSchemaFieldValue(field, rawDefault, pageSize, resolveContext) {
        var ctx = resolveContext || {};
        if (isDeallocatedFromLikeFieldKey(getFormFieldInternalName(field))) {
          var employeePair = resolveEmployeeLookupPair(rawDefault);
          if (employeePair) return employeePair;
        }
        if (isAssetIdFormLookupField(field) || isAssetIdLikeFieldKey(getFormFieldInternalName(field))) {
          return resolveAssetIdFieldForForm(
            field,
            rawDefault,
            ctx.assetRow,
            ctx.assetRecordId,
            pageSize
          );
        }
        if (isSchemaLookupField(field)) {
          var lookupResolved = await resolveSchemaLookupFieldValue(field, rawDefault, pageSize);
          if (!isBlankDisplayValue(lookupResolved)) return lookupResolved;
          if (isDeallocatedFromLikeFieldKey(getFormFieldInternalName(field))) {
            return resolveEmployeeLookupPair(rawDefault) || formatSchemaFieldValue(field, rawDefault);
          }
          return lookupResolved;
        }
        return formatSchemaFieldValue(field, rawDefault);
      }
    
      async function populateShowFieldsFromRecord(schemaFields, showFieldsWithValue, defaults, pageSize, populateOptions) {
        var popOpts = populateOptions || {};
        for (var i = 0; i < schemaFields.length; i += 1) {
          var field = schemaFields[i];
          var fname = getFormFieldInternalName(field);
          if (!fname) continue;
          if (isAssetIdFormLookupField(field)) {
            var assetIdDefault = findDefaultForField(defaults, "AssetID") || findDefaultForField(defaults, fname);
            if (assetIdDefault != null && toText(assetIdDefault) !== "") {
              var assetIdResolved = await resolveAssetIdFieldForForm(
                field,
                assetIdDefault,
                popOpts.assetRow,
                popOpts.assetRecordId,
                pageSize
              );
              for (var ai = 0; ai < showFieldsWithValue.length; ai += 1) {
                if (isFormAssetIdInternalName(showFieldsWithValue[ai].fieldName)) {
                  showFieldsWithValue[ai].fieldValue = assetIdResolved;
                }
              }
            }
            continue;
          }
          var rawDefault = findDefaultForField(defaults, fname);
          if (rawDefault == null || toText(rawDefault) === "") continue;
          var resolved = rawDefault;
          try {
            if (popOpts.isDeallocate) {
              resolved = await resolveDeallocateSchemaFieldValue(field, rawDefault, pageSize, popOpts);
            } else if (isSchemaLookupField(field)) {
              var quickPair = resolveAssignLookupPrefillValue(field, rawDefault);
              if (
                quickPair &&
                quickPair.indexOf(";#") >= 0 &&
                isGuid(lookupId(quickPair)) &&
                lookupToText(quickPair)
              ) {
                resolved = quickPair;
              } else {
                resolved = await resolveSchemaLookupFieldValue(field, rawDefault, pageSize);
                if (isBlankDisplayValue(resolved)) {
                  resolved = quickPair;
                }
              }
            } else {
              resolved = formatSchemaFieldValue(field, rawDefault);
            }
          } catch (e) {
            console.warn("populateShowFieldsFromRecord: field resolve failed for", fname, e && e.message ? e.message : e);
            resolved = formatSchemaFieldValue(field, rawDefault);
          }
          if (resolved == null || toText(resolved) === "") continue;
          for (var si = 0; si < showFieldsWithValue.length; si += 1) {
            if (showFieldsWithValue[si].fieldName === fname) {
              showFieldsWithValue[si].fieldValue = resolved;
              break;
            }
          }
        }
      }
    
      /**
       * Mirrors autopopulate.js openFormWithLookupPrefill: metadata-driven schema,
       * showFieldsWithValue format, and QafPageService.AddItem argument order.
       */
      async function openFormWithLookupPrefill(opts) {
        opts = opts || {};
        var resolvedForm = opts.resolvedForm
          ? opts.resolvedForm
          : await resolveFormConfig({
              formName: opts.formName,
              repositoryName: opts.repositoryName || opts.objectName,
              objectId: opts.objectId,
              viewId: opts.viewId,
              objectNameCandidates: opts.objectNameCandidates,
            });
        opts.objectId = resolvedForm.objectId;
        opts.viewId = resolvedForm.viewId;
        opts.repositoryName = resolvedForm.repositoryName;
        opts.objectName = opts.objectName || resolvedForm.repositoryName;
    
        var formTarget = resolvedForm.objectId || resolvedForm.repositoryName || opts.objectName;
        if (!formTarget) throw new Error("Could not resolve form object from repository name");
    
        var defaults = opts.defaults || {};
        var pageSize = typeof opts.pageSize === "number" ? opts.pageSize : 25;
        var isDeallocateOpen = isDeallocationForm(resolvedForm) || !!opts.isDeallocateForm;
        var showFieldsWithValue = await buildShowFieldsWithValuesForOpen(resolvedForm, defaults, pageSize, {
          forceAll: isDeallocateOpen,
          assetRow: opts.assetRow,
        });
    
        var qafPage = findHostService("QafPageService");
        var mode = opts.mode || (opts.recordId ? "edit" : "new");
        if (!opts.onSaveAction) {
          opts.onSaveAction =
            typeof opts.callback === "function"
              ? opts.callback
              : function inventoryStyleOnSaveAction() {
                  if (typeof window.qafAssetDetailsLoadAfterSave === "function") {
                    window.qafAssetDetailsLoadAfterSave();
                    return;
                  }
                  reloadAfterSave();
                };
        }
    
        if (qafPage) {
          if (mode === "new" && typeof qafPage.AddItem === "function") {
            var addItemResult = invokeAddItemWithShowFields(resolvedForm, showFieldsWithValue, opts);
            if (addItemResult) return addItemResult;
          }
          if (mode === "edit" && typeof qafPage.EditItem === "function") {
            if (!opts.recordId) throw new Error("recordId is required for edit");
            var editArgs = [
              resolvedForm.objectId || opts.object || opts.objectName || resolvedForm.repositoryName,
              opts.recordId,
              typeof opts.callback === "function" ? opts.callback : function () {},
              opts.showFields || undefined,
              showFieldsWithValue,
              opts.fieldFilterConditions || undefined,
              opts.fieldConversion || undefined,
              opts.hiddenFields || opts.hiddenFieldsForm || undefined,
              opts.excludeFieldFromForm || undefined,
              opts.onSaveAction || undefined,
              opts.changeTitles || undefined,
              opts.openAsPopup || undefined,
              opts.addUpdateApi || undefined,
              opts.readOnlyFormField || undefined,
              opts.requiredFormField || undefined,
              opts.whereclauseForRecordID || undefined,
            ];
            qafPage.EditItem.apply(qafPage, editArgs);
            return { openedBy: "QafPageService.EditItem" };
          }
        }
    
        throw new Error("QafPageService not found; cannot open host form");
      }
    
      function warmUpAllocationFormApis(resolvedFormConfig) {
        return Promise.resolve(resolvedFormConfig || {});
      }
    
      function tryOpenAddFormViaPageService(formConfig, prefillBundle) {
        var qafPageService = window.QafPageService || (window.parent && window.parent.QafPageService) || null;
        if (!qafPageService) return false;
        var methodNames = ["AddItem", "AddNewItem", "CreateItem", "OpenCreateItem", "OpenNewItem", "NewItem"];
        var targets = [formConfig.repositoryName, formConfig.formName, formConfig.objectId].filter(Boolean);
        var seen = {};
        targets = targets.filter(function (target) {
          var key = String(target).toLowerCase();
          if (seen[key]) return false;
          seen[key] = true;
          return true;
        });
        var onDone = reloadAfterSave;
        var contextObj = prefillBundle && prefillBundle.contextObj;
        if (contextObj) {
          contextObj.onSaveAction = reloadAfterSave;
          contextObj.onDone = reloadAfterSave;
        }
        var recordFieldValues = prefillBundle && prefillBundle.recordFieldValues;
        var defaultFieldValues = prefillBundle && prefillBundle.defaultFieldValues;
        for (var m = 0; m < methodNames.length; m += 1) {
          var methodName = methodNames[m];
          if (typeof qafPageService[methodName] !== "function") continue;
          for (var t = 0; t < targets.length; t += 1) {
            var target = targets[t];
            var attempts = [];
            if (recordFieldValues && defaultFieldValues) {
              attempts.push([target, recordFieldValues, defaultFieldValues, onDone]);
              attempts.push([target, recordFieldValues, defaultFieldValues]);
            }
            if (contextObj) {
              attempts.push([target, contextObj, onDone]);
              attempts.push([target, contextObj]);
            }
            attempts.push([target, onDone]);
            attempts.push([target]);
            for (var a = 0; a < attempts.length; a += 1) {
              try {
                qafPageService[methodName].apply(qafPageService, attempts[a]);
                return true;
              } catch (_) {}
            }
          }
        }
        return false;
      }
    
      function resolveFormViewId(formConfig) {
        if (toText(formConfig && formConfig.viewId)) return Promise.resolve(formConfig.viewId);
        if (!toText(formConfig && formConfig.objectId)) return Promise.resolve("");
        return fetchViewIdOnce(formConfig.objectId);
      }
    
      function buildAllocationFormUrl(formConfig, context, viewId, newGuid) {
        var url = new URL(window.location.origin + "/workflow-engine/i-form");
        url.searchParams.set("mode", "new");
        if (toText(formConfig.objectId)) url.searchParams.set("objectID", formConfig.objectId);
        if (toText(viewId || formConfig.viewId)) {
          url.searchParams.set("viewID", viewId || formConfig.viewId);
        }
        if (toText(formConfig.repositoryName)) {
          url.searchParams.set("repositoryName", formConfig.repositoryName);
          url.searchParams.set("objectName", formConfig.repositoryName);
        }
        if (newGuid) url.searchParams.set("recordID", newGuid);
        if (context.assetRecordID) {
          url.searchParams.set("assetRecordID", context.assetRecordID);
          url.searchParams.set("sourceAssetRecordID", context.sourceAssetRecordID || context.assetRecordID);
        }
        if (context.typeRaw || context.type) {
          var typeValue = context.typeRaw || context.type;
          url.searchParams.set("Type", typeValue);
          url.searchParams.set("type", typeValue);
        }
        if (context.categoryRaw || context.category) {
          var categoryValue = context.categoryRaw || context.category;
          url.searchParams.set("Category", categoryValue);
          url.searchParams.set("category", categoryValue);
        }
        if (context.assetID) {
          url.searchParams.set("AssetID", context.assetID);
          url.searchParams.set("assetID", context.assetID);
        }
        if (isDeallocationForm(formConfig)) {
          var deallocatedValue = context.deallocatedFromUser || context.assignedToRaw || context.assignedTo;
          if (deallocatedValue) {
            url.searchParams.set("DeallocatedFromUser", deallocatedValue);
            url.searchParams.set("deallocatedFromUser", deallocatedValue);
            url.searchParams.set("DeallocatedFrom", deallocatedValue);
            url.searchParams.set("deallocatedFrom", deallocatedValue);
          }
        } else if (context.assignedToRaw || context.assignedTo) {
          var assignedValue = context.assignedToRaw || context.assignedTo;
          url.searchParams.set("AssignedTo", assignedValue);
          url.searchParams.set("assignedTo", assignedValue);
        }
        return url.toString();
      }
    
      /**
       * After a successful edit, fetch only the single updated record from the API
       * and patch it into state.allAssets in-place, then re-render. No full reload.
       */
      function patchSingleAsset(recordId) {
        var id = toText(recordId);
        if (!id) return;
        var whereClause = "RecordID='" + id.replace(/'/g, "''") + "'";
        resolveMasterAssetFieldList().then(function (fieldList) {
          fetchRecordsPage({
            objectNames: ASSET_OBJECT_CANDIDATES,
            fieldList: fieldList,
            pageNumber: 1,
            pageSize: 1,
            whereClause: whereClause,
            isAscending: false,
          }).then(function (rows) {
            if (!rows || !rows.length) return;
            var updated = rows[0];
            var idx = state.allAssets.findIndex(function (r) {
              return toText(getValue(r, ["RecordID", "RecordId", "recordID", "ID", "Id"])).toLowerCase() === id.toLowerCase();
            });
            if (idx >= 0) {
              state.allAssets[idx] = updated;
            } else {
              state.allAssets.unshift(updated);
            }
            renderGrid();
          }).catch(function () {});
        });
      }
    
      function openMasterEdit(recordId) {
        var safeRecordId = toText(recordId);
        return fetchAssetRowByRecordId(safeRecordId).then(function (row) {
          storeAssetPrefill(row || {}, safeRecordId, MASTER_EDIT);
          if (window.QafLibrary && window.QafLibrary.openOotbForm) {
            if (
              window.QafLibrary.openOotbForm({
                mode: "edit",
                recordID: safeRecordId,
                repositoryName: MASTER_EDIT.repositoryName,
                objectID: MASTER_EDIT.objectId,
                onDone: function () {
                  patchSingleAsset(safeRecordId);
                },
              })
            ) {
              return;
            }
          }
          var url = new URL(window.location.origin + "/workflow-engine/i-form");
          url.searchParams.set("mode", "edit");
          url.searchParams.set("objectID", MASTER_EDIT.objectId);
          url.searchParams.set("viewID", MASTER_EDIT.viewId);
          url.searchParams.set("recordID", safeRecordId);
          window.location.assign(url.toString());
        });
      }
    
      function openAllocationForm(recordId, formConfig) {
        var safeRecordId = toText(recordId);
        formConfig = normalizeFormConfigForOpen(formConfig);
        return resolveFormConfig(formConfig).then(function (resolvedFormConfig) {
            var isDeallocateFormOpen = isDeallocationForm(resolvedFormConfig);
            return fetchAssetRowForFormPrefill(safeRecordId).then(function (row) {
              return { row: row || {}, resolvedFormConfig: resolvedFormConfig, isDeallocateFormOpen: isDeallocateFormOpen };
            });
          })
          .then(function (payload) {
            var row = payload.row;
            var resolvedFormConfig = payload.resolvedFormConfig;
            var isDeallocateFormOpen = !!payload.isDeallocateFormOpen;
            var prepareEmployees =
              isDeallocateFormOpen && !(state.employeeRows && state.employeeRows.length)
                ? loadEmployeeData()
                : Promise.resolve();
            return prepareEmployees.then(function () {
              var assignedResolver = isDeallocateFormOpen
                ? resolveAssignedToForDeallocateForm(row, safeRecordId)
                : Promise.resolve({ raw: "", display: "" });
              return assignedResolver.then(function (assignedResolved) {
              var prefillBundle = buildAssetFormPrefillBundle(row, safeRecordId, resolvedFormConfig, {
                mode: "new",
                assignedResolved: assignedResolved,
              });
              var context = prefillBundle.context;
              applyAssetFormPrefill(resolvedFormConfig, prefillBundle, safeRecordId);
              var sourceDefaults = buildSourceDefaultsFromAssetRow(
                row,
                prefillBundle,
                resolvedFormConfig,
                safeRecordId
              );
              var isDeallocateForm = isDeallocateFormOpen || isDeallocationForm(resolvedFormConfig);
              if (isDeallocateForm) {
                sourceDefaults = finalizeDeallocateSourceDefaults(
                  sourceDefaults,
                  row,
                  prefillBundle,
                  enrichRow(row),
                  safeRecordId
                );
              }
              return openFormWithLookupPrefill({
                mode: "new",
                resolvedForm: resolvedFormConfig,
                isDeallocateForm: isDeallocateForm,
                assetRow: row,
                objectId: resolvedFormConfig.objectId,
                repositoryName: resolvedFormConfig.repositoryName,
                objectName: resolvedFormConfig.repositoryName,
                formName: resolvedFormConfig.formName,
                viewId: resolvedFormConfig.viewId,
                objectNameCandidates: resolvedFormConfig.objectNameCandidates,
                defaults: sourceDefaults,
                pageSize: 25,
                openAsPopup: false,
                callback: function () {
                  reloadAll();
                },
              })
                .then(function (openResult) {
                  if (openResult && openResult.openedBy) return openResult;
                  throw new Error("Form host did not open");
                })
                .catch(function (prefillErr) {
                  console.warn(
                    "openFormWithLookupPrefill failed:",
                    prefillErr && prefillErr.message ? prefillErr.message : prefillErr
                  );
                  if (isDeallocateForm) {
                    return buildShowFieldsWithValuesForOpen(resolvedFormConfig, sourceDefaults, 25, {
                      forceAll: true,
                      assetRow: row,
                    })
                      .then(function (showFieldsWithValue) {
                        var addResult = invokeAddItemWithShowFields(resolvedFormConfig, showFieldsWithValue, {
                          callback: function () {
                            reloadAll();
                          },
                          openAsPopup: false,
                        });
                        if (addResult && addResult.openedBy) return addResult;
                        throw prefillErr;
                      })
                      .catch(function () {
                        if (tryOpenAddFormViaPageService(resolvedFormConfig, prefillBundle)) return;
                        throw prefillErr;
                      });
                  }
                  if (tryOpenAddFormViaPageService(resolvedFormConfig, prefillBundle)) return;
                  if (window.QafLibrary && window.QafLibrary.openAddForm) {
                    if (
                      window.QafLibrary.openAddForm({
                        repositoryName: resolvedFormConfig.repositoryName,
                        objectID: resolvedFormConfig.objectId || resolvedFormConfig.repositoryName,
                        onDone: function () {
                          reloadAll();
                        },
                      })
                    ) {
                      return;
                    }
                  }
                  return resolveFormViewId(resolvedFormConfig).then(function (resolvedViewId) {
                    return fetchNewRecordGuidOnce().then(function (newGuid) {
                      window.location.assign(
                        buildAllocationFormUrl(resolvedFormConfig, context, resolvedViewId, newGuid)
                      );
                    });
                  });
                });
              });
            });
          });
      }
    function setPrefillBridge(bridge) {
      prefillBridge = bridge || null;
      if (bridge && Array.isArray(bridge.cachedAssetRows)) {
        state.allAssets = bridge.cachedAssetRows.slice();
        state.searchAssets = bridge.cachedAssetRows.slice();
      }
    }
    function getAssetRowByRecordId(recordId) {
      if (prefillBridge && typeof prefillBridge.getAssetRowByRecordId === "function") {
        return prefillBridge.getAssetRowByRecordId(recordId);
      }
      var target = String(recordId || "").trim().toLowerCase();
      if (!target) return null;
      var lists = [state.searchAssets, state.allAssets];
      for (var li = 0; li < lists.length; li += 1) {
        var list = lists[li] || [];
        for (var i = 0; i < list.length; i += 1) {
          var row = list[i];
          var rid = toText(getValue(row, ["RecordID", "RecordId", "recordID", "ID", "Id"])).toLowerCase();
          if (rid === target) return row;
        }
      }
      return null;
    }
    function reloadAfterSave() {
      if (typeof window.qafAssetDetailsLoadAfterSave === "function") {
        window.qafAssetDetailsLoadAfterSave();
        return;
      }
      if (prefillBridge && typeof prefillBridge.onSaveSuccess === "function") {
        prefillBridge.onSaveSuccess();
        return;
      }
      reloadAll();
    }

    function reloadAll() {
      if (prefillBridge && typeof prefillBridge.onDone === "function") {
        prefillBridge.onDone();
        return;
      }
      if (typeof window.qafAssetDetailsLoadAfterSave === "function") {
        window.qafAssetDetailsLoadAfterSave();
      }
    }
    return {
      setPrefillBridge: setPrefillBridge,
      openAllocationForm: openAllocationForm,
      ALLOCATION_FORM: ALLOCATION_FORM,
      DEALLOCATION_FORM: DEALLOCATION_FORM,
      MASTER_EDIT: MASTER_EDIT
    };
  })();


  function getAssetRowForPrefillByRecordId(recordId) {
    const target = String(recordId || "").trim().toLowerCase();
    if (!target) return null;
    const recordKey = `RecordID:${String(recordId || "").trim()}`;
    const keyed = state.rawRowsByRecordKey && state.rawRowsByRecordKey[recordKey];
    if (keyed && getRecordIDFromRow(keyed)) return keyed;
    const cachedRows = Object.values(state.rawRowsByRecordKey || {});
    for (let i = 0; i < cachedRows.length; i += 1) {
      const row = cachedRows[i];
      const rid = String(getRecordIDFromRow(row) || "")
        .trim()
        .toLowerCase();
      if (rid === target) return row;
    }
    return null;
  }

  function syncAllocationFormPrefillBridge() {
    allocationFormPrefill.setPrefillBridge({
      onDone: loadDataAfterSave,
      onSaveSuccess: loadDataAfterSave,
      cachedAssetRows: Object.values(state.rawRowsByRecordKey || {}),
      getAssetRowByRecordId: getAssetRowForPrefillByRecordId
    });
  }

  async function openAllocationForm(recordKey, row, recordID) {
    const safeRecordId = String(recordID || "").trim();
    if (!safeRecordId) throw new Error("Missing asset record id.");
    if (!canAssignOrDeallocateAsset(getPermissionRawRow(row))) return;
    markRefreshOnReturn();
    syncAllocationFormPrefillBridge();
    await allocationFormPrefill.openAllocationForm(
      safeRecordId,
      allocationFormPrefill.ALLOCATION_FORM
    );
  }

  async function openDeallocationForm(recordKey, row, recordID) {
    const safeRecordId = String(recordID || "").trim();
    if (!safeRecordId) throw new Error("Missing asset record id.");
    if (!canAssignOrDeallocateAsset(getPermissionRawRow(row))) return;
    markRefreshOnReturn();
    syncAllocationFormPrefillBridge();
    await allocationFormPrefill.openAllocationForm(
      safeRecordId,
      allocationFormPrefill.DEALLOCATION_FORM
    );
  }

  async function openMasterEditForm(assetRecordId) {
    const recordId = String(assetRecordId || "").trim();
    if (!recordId) throw new Error("Missing asset record id.");
    const rawRow =
      getAssetRowForPrefillByRecordId(recordId) ||
      Object.values(state.rawRowsByRecordKey || {}).find(
        (row) => String(getRecordIDFromRow(row) || "").trim() === recordId
      ) ||
      null;
    if (!canEditAsset(rawRow)) return;

    markRefreshOnReturn();
    syncAllocationFormPrefillBridge();

    const objectID = MASTER_EDIT_FORM.objectId;
    const viewID = MASTER_EDIT_FORM.viewId || (await getAssetViewId());

    const objectParams = new URLSearchParams({
      option: "object",
      objectID
    });
    const viewParams = new URLSearchParams({
      objectID
    });
    const recordsParams = new URLSearchParams({
      viewID
    });

    try {
      const preflight = [
        fetchJson(`${getAppApiBase()}/api/ViewGet?${viewParams.toString()}`, undefined).catch(
          () => null
        )
      ];
      if (!state.masterObjectRow) {
        preflight.unshift(
          fetchJson(`${getAppApiBase()}/api/ObjectGet?${objectParams.toString()}`, undefined).catch(
            () => null
          )
        );
      }
      await Promise.all(preflight);
      await fetchJson(
        `${getAppApiBase()}/api/GetRecords?${recordsParams.toString()}`,
        undefined
      ).catch(() => []);
    } catch (_error) {
      // Pre-flight failures should not block opening the form.
    }

    const qafPageService = window.QafPageService || (window.parent && window.parent.QafPageService);
    if (qafPageService && typeof qafPageService.EditItem === "function") {
      const objectCandidate = null;
      const targets = [
        MASTER_EDIT_FORM.repository,
        MASTER_EDIT_FORM.formName,
        "Easset_Master",
        "EAsset Master",
        "EAsset_Master",
        objectCandidate && objectCandidate.DisplayName,
        objectCandidate && objectCandidate.InternalName,
        objectID
      ].filter(Boolean);

      for (let i = 0; i < targets.length; i += 1) {
        const target = targets[i];
        try {
          qafPageService.EditItem(target, recordId, function () {});
          return;
        } catch (_error) {
          // Try next target.
        }
      }
    }

    const formUrl = new URL(`${window.location.origin}/workflow-engine/i-form`);
    formUrl.searchParams.set("mode", "edit");
    formUrl.searchParams.set("objectID", objectID);
    formUrl.searchParams.set("recordID", recordId);
    window.location.assign(formUrl.toString());
  }

  async function openMasterViewForm(assetRecordId) {
    const recordId = String(assetRecordId || "").trim();
    if (!recordId) throw new Error("Missing asset record id.");

    markRefreshOnReturn();

    const objectID = MASTER_EDIT_FORM.objectId;
    const viewID = MASTER_EDIT_FORM.viewId || (await getAssetViewId());
    const qafPageService = window.QafPageService || (window.parent && window.parent.QafPageService);

    if (qafPageService && typeof qafPageService.ViewItem === "function") {
      const targets = [
        MASTER_EDIT_FORM.repository,
        MASTER_EDIT_FORM.formName,
        "Easset_Master",
        "EAsset Master",
        "EAsset_Master",
        objectID
      ].filter(Boolean);

      for (let i = 0; i < targets.length; i += 1) {
        try {
          qafPageService.ViewItem(targets[i], recordId, function () {});
          return;
        } catch (_error) {
          // Try next target.
        }
      }
    }

    const formUrl = new URL(`${window.location.origin}/workflow-engine/i-form`);
    formUrl.searchParams.set("mode", "view");
    formUrl.searchParams.set("objectID", objectID);
    formUrl.searchParams.set("viewID", viewID);
    formUrl.searchParams.set("recordID", recordId);
    formUrl.searchParams.set("drMode", "true");
    window.location.assign(formUrl.toString());
  }

  async function openOutOfBoxRepositoryForm(
    repositoryName,
    row,
    recordID,
    sourceRecord,
    signal,
    repositoryObjectKey
  ) {
    markRefreshOnReturn();
    const objectKey = String(repositoryObjectKey || "").trim() || String(repositoryName || "").trim();
    const repoContext = await resolveRepositoryContext(repositoryName, signal, objectKey);
    if (!repoContext || !repoContext.objectID) {
      throw new Error(`Could not resolve object for ${repositoryName}.`);
    }
    let viewID = String(repoContext.viewID || "").trim();
    if (!viewID) {
      const viewTargets = [objectKey, repoContext.objectID].filter(Boolean);
      for (let i = 0; i < viewTargets.length; i += 1) {
        try {
          const viewPayload = await fetchJson(
            `${getAppApiBase()}/api/ViewGet?objectID=${encodeURIComponent(viewTargets[i])}`,
            signal
          );
          const viewRows = normalizeRecords(viewPayload);
          const firstView = viewRows[0] || {};
          viewID = String(firstView.ViewID || "").trim();
          if (viewID) break;
        } catch (_error) {
          // Try next target.
        }
      }
    }
    if (!viewID) {
      throw new Error(`Could not resolve view for ${repositoryName}.`);
    }
    const newRecordID = await requestNewRecordGuid();
    const context = {
      objectID: repoContext.objectID,
      objectName: repoContext.objectName || repositoryName,
      repository: repositoryName,
      viewID,
      recordID: newRecordID
    };
    const launched = tryLaunchRepositoryOutOfBoxForm(context);
    if (!launched) {
      openRepositoryIFormFallbackUrl(context);
    }
  }

  function tryLaunchBulkImportWithQafService(context) {
    const services = [window.QafPageService, window.parent && window.parent.QafPageService].filter(Boolean);
    const methods = [
      "OpenBulkImport",
      "OpenImport",
      "OpenImportPanel",
      "BulkImport",
      "ImportItem",
      "ImportItems",
      "ImportRecords"
    ];
    const argsList = [
      [context.objectID],
      [context.objectID, context.viewID],
      [context.objectName],
      [context.objectName, context.viewID],
      [context.repository],
      [context.repository, context.viewID],
      [{ ...context }],
      [{ ...context, mode: "import", importMode: "bulk" }],
      [context.objectID, context.objectName, context.viewID]
    ];

    for (let i = 0; i < services.length; i += 1) {
      const service = services[i];
      for (let m = 0; m < methods.length; m += 1) {
        const fn = service && service[methods[m]];
        if (typeof fn !== "function") continue;
        for (let a = 0; a < argsList.length; a += 1) {
          try {
            fn.apply(service, argsList[a]);
            return true;
          } catch (_error) {
            // Try next signature.
          }
        }
      }
    }
    return false;
  }

  function openBulkImportFallbackUrl(context) {
    const candidates = [
      `${window.location.origin}/workflow-engine/import-bulk-data`,
      `${window.location.origin}/workflow-engine/import`,
      `${window.location.origin}/assets/import-bulk-data`
    ];
    const params = new URLSearchParams({
      objectID: context.objectID,
      viewID: context.viewID,
      objectName: context.objectName,
      repository: context.repository,
      mode: "import"
    });
    window.location.assign(`${candidates[0]}?${params.toString()}`);
  }

  async function openOutOfBoxBulkImport() {
    if (isToolbarCreationRestricted()) return;
    markRefreshOnReturn();
    syncBundleEnvUrl();

    const categoryVal = formatLookupPrefillValue(state.categoryId, state.categoryLabel);
    const typeVal = formatLookupPrefillValue(state.typeId, state.typeLabel);
    const hiddenFieldsWithValue = [];
    if (categoryVal) hiddenFieldsWithValue.push("Category:" + categoryVal);
    if (typeVal) hiddenFieldsWithValue.push("Type:" + typeVal);
    const hiddenFields = ["ModifiedBy", "Modified"];

    const onImportDone = function (_result) {
      loadDataAfterSave();
    };

    const qafPage = await waitForImportBulkDataService(5000);
    const objectNames = [MASTER_LIST_OBJECT_NAME, "EAsset Master"];
    let lastError = null;

    for (let i = 0; i < objectNames.length; i += 1) {
      const objectName = objectNames[i];
      try {
        invokeImportBulkDataOnService(
          qafPage,
          objectName,
          onImportDone,
          hiddenFieldsWithValue,
          hiddenFields
        );
        return;
      } catch (error) {
        lastError = error;
      }
      try {
        if (typeof qafPage.ImportBulkData === "function") {
          qafPage.ImportBulkData(objectName, onImportDone);
          return;
        }
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("Unable to open import form.");
  }

  /** Payload for `api/rnsp`'s item-status-count workflow; TypeFilter/CategoryFilter mirror the route's selected Type/Category GUIDs. */
  function buildItemStatusRnspPayload() {
    return {
      Name: ITEM_STATUS_RNSP_NAME,
      Args: {
        TypeFilter: String(state.typeId || "").trim(),
        CategoryFilter: String(state.categoryId || "").trim()
      }
    };
  }

  function categoryMatches(row) {
    if (!state.categoryId && !state.categoryLabel) return false;
    const rawCategory = String(
      (row && row.Category) ||
        getRecordFieldValueByInternalNames(row, ["Category"]) ||
        ""
    ).trim();
    if (!rawCategory) {
      return Boolean(String(state.categoryId || "").trim());
    }
    if (state.categoryId && rawCategory.includes(state.categoryId)) return true;
    const routeLabel = normalizeCategoryToken(state.categoryLabel);
    if (!routeLabel) return false;
    const parsedLabel = normalizeCategoryToken(parseLookupLabel(rawCategory));
    if (parsedLabel === routeLabel) return true;
    return normalizeCategoryToken(rawCategory) === routeLabel;
  }

  function getRowItemStatus(row) {
    return String(
      resolveFieldValue(row, "ItemStatus") ||
        (row && row.ItemStatus) ||
        getRecordFieldValueByInternalNames(row, ["ItemStatus"]) ||
        ""
    ).trim();
  }

  function statusMatches(row, effectiveStatus) {
    const status = String(effectiveStatus || "").trim();
    if (!status) return true;
    const rowStatus = getRowItemStatus(row);
    if (!rowStatus) return false;
    const rowLabel = parseLookupLabel(rowStatus) || rowStatus;
    const rowCanonical = toCanonicalStatus(rowLabel);
    const targetCanonical = toCanonicalStatus(status);
    return (
      normalizeStatusToken(rowCanonical) === normalizeStatusToken(targetCanonical) ||
      normalizeStatusToken(rowLabel) === normalizeStatusToken(targetCanonical) ||
      normalizeStatusToken(rowStatus) === normalizeStatusToken(targetCanonical)
    );
  }

  function typeMatches(row) {
    const routeTypeId = String(state.typeId || "").trim();
    const routeTypeLabel = normalizeCategoryToken(state.typeLabel);
    if (!routeTypeId && !routeTypeLabel) return true;
    const rawType = String(
      (row && row.Type) ||
        getRecordFieldValueByInternalNames(row, ["Type"]) ||
        ""
    );
    if (!rawType) {
      return Boolean(routeTypeId);
    }
    if (routeTypeId && rawType.includes(routeTypeId)) return true;
    const rowTypeLabel = normalizeCategoryToken(parseLookupLabel(rawType));
    return Boolean(routeTypeLabel && rowTypeLabel === routeTypeLabel);
  }

  function escapeClauseValue(value) {
    return String(value || "").replace(/'/g, "''");
  }

  function isApiWhereClauseFieldName(fieldName) {
    const name = String(fieldName || "").trim();
    return /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
  }

  function isSearchableFieldMeta(meta) {
    if (!meta) return true;
    const type = String(meta.dataType || "").toUpperCase();
    return !["DTE", "DTM", "IMG", "DOC", "ATT", "BIN", "BOL"].includes(type);
  }

  const ASSET_SEARCH_FIELD_ORDER = [
    "AssetID",
    "SerialNumber",
    "AssetName",
    "ItemStatus",
    "Type",
    "Category",
    "SubCategory",
    "Location",
    "Department",
    "AssignedTo",
    "Project"
  ];

  function orderAssetSearchFieldNames(names) {
    const orderIndex = new Map(ASSET_SEARCH_FIELD_ORDER.map((name, index) => [name, index]));
    return [...names].sort((a, b) => {
      const aIndex = orderIndex.has(a) ? orderIndex.get(a) : ASSET_SEARCH_FIELD_ORDER.length;
      const bIndex = orderIndex.has(b) ? orderIndex.get(b) : ASSET_SEARCH_FIELD_ORDER.length;
      if (aIndex !== bIndex) return aIndex - bIndex;
      return a.localeCompare(b);
    });
  }

  function isFieldOnMasterObject(fieldName) {
    if (!state.objectFieldMetaByInternalName) return true;
    const normalized = normalizeFieldName(fieldName);
    return Boolean(state.objectFieldMetaByInternalName[normalized]);
  }

  function getAssetSearchFieldNames() {
    const seen = new Set();
    const names = [];
    const add = (rawName, meta) => {
      const name = String(rawName || "").trim();
      if (!name || !isApiWhereClauseFieldName(name) || seen.has(name)) return;
      if (!isFieldOnMasterObject(name)) return;
      if (meta && !isSearchableFieldMeta(meta)) return;
      seen.add(name);
      names.push(name);
    };

    getViewFieldsFetchFieldList().forEach((fieldName) => {
      const compact = toGetItemMatchKey(fieldName);
      [fieldName, compact].forEach((candidate) => {
        add(candidate, getFieldMetaForColumnKey(candidate));
      });
    });

    getActiveColumnDefs().forEach((column) => {
      const key = String((column && column.key) || "").trim();
      if (!key) return;
      const meta = getFieldMetaForColumnKey(key);
      const internalName = String(
        (meta && meta.internalName) || column.internalName || getInternalNameForColumnKey(key) || ""
      ).trim();
      if (internalName) add(internalName, meta);
      add(key, meta);
    });

    return orderAssetSearchFieldNames(names);
  }

  function getAssetRequestedFieldList() {
    const viewFieldNames = getViewFieldsFetchFieldList();
    return [
      ...new Set([
        ...MERGE_KEY_FIELDS,
        ...LIST_ANCHOR_FIELDS,
        ...(viewFieldNames.length ? viewFieldNames : getActiveFieldList())
      ])
    ];
  }

  function getRowSearchableFieldValue(row, fieldName) {
    const merged = mergeRecordFieldValuesIntoRow(row);
    const key = String(fieldName || "").trim();
    if (!key) return "";
    if (Object.prototype.hasOwnProperty.call(merged, key)) {
      const direct = merged[key];
      if (direct != null && String(direct).trim() !== "") return direct;
    }
    const resolved = resolveFieldValue(merged, key);
    if (resolved != null && String(resolved).trim() !== "") return resolved;
    return getRecordFieldValueByInternalNames(merged, [key]) || "";
  }

  /**
   * Category scope for EAsset_Master: exact `Category='{categoryGuid}'` only.
   */
  function buildAssetCategoryWhereClause() {
    const categoryId = String(state.categoryId || "").trim();
    if (!categoryId) return "";
    return `Category='${escapeClauseValue(categoryId)}'`;
  }

  function buildAssetTypeWhereClause() {
    const typeId = String(state.typeId || "").trim();
    if (!typeId) return "";
    return `Type='${escapeClauseValue(typeId)}'`;
  }

  function buildAssetRouteScopeClause() {
    const parts = [buildAssetCategoryWhereClause(), buildAssetTypeWhereClause()].filter(Boolean);
    return parts.join("<<NG>>");
  }

  /**
   * EAsset_Master whereClause when not searching: category-only, or category + ItemStatus for summary cards.
   */
  function buildAssetMasterWhereClause(effectiveStatus) {
    const scopeClause = buildAssetRouteScopeClause();
    if (!scopeClause) return "";
    const status = String(effectiveStatus || "").trim();
    if (!status) return scopeClause;
    const canonicalStatus = toCanonicalStatus(status);
    if (!canonicalStatus) return scopeClause;
    const statusEscaped = escapeClauseValue(canonicalStatus);
    return `${scopeClause}<<NG>>(ItemStatus='${statusEscaped}'<OR>ItemStatus<contains>'${statusEscaped}')`;
  }

  function isAssetSearchActive() {
    return Boolean(String(state.searchQuery || "").trim());
  }

  function buildAssetFieldSearchClause(rawSearch) {
    const trimmed = String(rawSearch || "").trim();
    if (!trimmed) return "";
    const q = escapeClauseValue(trimmed);
    const fields = getAssetSearchFieldNames();
    if (!fields.length) return "";
    return fields.map((field) => `${field}<contains>'${q}'`).join("<OR>");
  }

  /**
   * Search bar whereClause: `Category='{guid}'<<NG>>` optional ItemStatus, then field `<contains>` OR group.
   */
  function buildAssetSearchWhereClause(rawSearch, effectiveStatus) {
    const scopeClause = buildAssetRouteScopeClause();
    if (!scopeClause) return "";
    const searchClause = buildAssetFieldSearchClause(rawSearch);
    if (!searchClause) return buildAssetMasterWhereClause(effectiveStatus);
    const parts = [scopeClause];
    const status = String(effectiveStatus || "").trim();
    if (status) {
      const canonicalStatus = toCanonicalStatus(status);
      if (canonicalStatus) {
        const statusEscaped = escapeClauseValue(canonicalStatus);
        parts.push(`(ItemStatus='${statusEscaped}'<OR>ItemStatus<contains>'${statusEscaped}')`);
      }
    }
    parts.push(`(${searchClause})`);
    return parts.join("<<NG>>");
  }

  /** Resolves list whereClause: search-aware, otherwise category / status only. */
  function buildAssetMasterListWhereClause(effectiveStatus) {
    if (isAssetSearchActive()) {
      return buildAssetSearchWhereClause(state.searchQuery, effectiveStatus);
    }
    return buildAssetMasterWhereClause(effectiveStatus);
  }

  /** Page size for `api/rnsp` PageSize: always the fixed PAGE_SIZE default. */
  function getAssetListFetchPageSize() {
    return PAGE_SIZE;
  }

  function rowSerialContainsQuery(row, rawSearch) {
    const q = String(rawSearch || "").trim().toLowerCase();
    if (!q) return true;

    const tokens = [];
    const pushSearchToken = (value) => {
      const normalized = normalizeAnyValue(value);
      if (normalized) tokens.push(String(normalized).toLowerCase());
      if (value != null && String(value).trim() !== "") {
        const label = parseLookupLabel(String(value));
        if (label) tokens.push(String(label).toLowerCase());
      }
    };

    getAssetSearchFieldNames().forEach((fieldName) => {
      const rawValue = getRowSearchableFieldValue(row, fieldName);
      if (fieldName === "AssignedTo") {
        pushSearchToken(rawValue);
        parseAssignedRecordIds(rawValue).forEach((id) => {
          pushSearchToken(state.employeesMap[id] || id);
        });
        return;
      }
      if (fieldName === "AssetManager" || fieldName === "Asset Manager") {
        pushSearchToken(rawValue);
        collectAssetManagerIds(row).forEach((id) => {
          pushSearchToken(state.employeesMap[id] || id);
        });
        return;
      }
      pushSearchToken(rawValue);
    });

    getActiveColumnDefs().forEach((column) => {
      if (!column || !column.isDate) return;
      const columnKey = column.key;
      const rawValue = getRowSearchableFieldValue(row, getInternalNameForColumnKey(columnKey));
      if (!rawValue) return;
      const normalized = normalizeAnyValue(rawValue);
      pushSearchToken(
        formatTableDateValue(normalized, {
          meta: getFieldMetaForColumnKey(columnKey),
          dateOnly: columnKey === "Created Date" || column.isDateOnly === true,
          isDateTime: column.isDateTime === true,
          forceUtc: true
        })
      );
    });

    if (tokens.some((token) => token.includes(q))) return true;

    const merged = mergeRecordFieldValuesIntoRow(row);
    for (const key of Object.keys(merged)) {
      if (key === "RecordFieldValues") continue;
      const normalized = normalizeAnyValue(merged[key]);
      if (normalized && String(normalized).toLowerCase().includes(q)) return true;
    }
    return false;
  }


  function getExpectedAssetCount() {
    const selected = String(state.selectedStatus || "").trim();
    if (Array.isArray(state.statusSummary) && state.statusSummary.length) {
      const targetToken =
        !selected || selected === "GrossTotal"
          ? normalizeStatusToken("GrossTotal")
          : normalizeStatusToken(selected);
      for (let i = 0; i < state.statusSummary.length; i += 1) {
        const item = state.statusSummary[i] || {};
        if (normalizeStatusToken(item.ItemStatus) !== targetToken) continue;
        const count = Number(item.TotalNumber);
        if (Number.isFinite(count) && count >= 0) return count;
      }
    }
    const routeCount = Number(state.routeAssetCount);
    return Number.isFinite(routeCount) && routeCount >= 0 ? routeCount : 0;
  }

  function filterAssetRowsForRoute(rows, effectiveStatus) {
    let filtered = (Array.isArray(rows) ? rows : [])
      .map((r) => normalizeAssetListRow(r))
      .filter((row) => categoryMatches(row) && typeMatches(row));
    const status = String(effectiveStatus || "").trim();
    if (status) {
      filtered = filtered.filter((row) => statusMatches(row, effectiveStatus));
    }
    if (isAssetSearchActive()) {
      filtered = filtered.filter((row) => rowSerialContainsQuery(row, state.searchQuery));
    }
    return filtered;
  }

  function shouldShowMoreAssetPages(rawCount, totalRecords, apiPageFetched) {
    const pageSize = getAssetListFetchPageSize();
    const total = Number(totalRecords);
    const pageFetched = Number(apiPageFetched);
    if (totalRecords != null && Number.isFinite(total) && total >= 0 && Number.isFinite(pageFetched)) {
      return pageFetched * pageSize < total;
    }
    return Number(rawCount) >= pageSize;
  }

  async function commitFirstAssetPage(signal, effectiveStatus, firstPage, loadSessionVersion) {
    if (loadSessionVersion != null && loadSessionVersion !== state.requestVersion) return false;
    let uniqueRaw = filterNewRawRowsByDedupe(firstPage.rows);
    await mergeEmployeesFromRows(uniqueRaw, signal);
    if (loadSessionVersion != null && loadSessionVersion !== state.requestVersion) return false;
    uniqueRaw.forEach((rawRow) => {
      const key = getRecordKeyFromRow(rawRow);
      if (!key) return;
      state.rawRowsByRecordKey[key] = rawRow;
    });

    const columnsChanged = reconcileColumnKeysFromRows(uniqueRaw);
    if (columnsChanged) {
      resetColumnWidthsForFreshData();
      renderTableHead();
    }

    state.apiRows = uniqueRaw.map((r) => formatRow(r, state.employeesMap));
    state.assetsHasMore = shouldShowMoreAssetPages(firstPage.rawCount, firstPage.totalRecords, 1);
    state.nextApiPage = 2;
    state.hasLoadedOnce = true;
    rebuildAllRows();
    await warmAssetManagerGuidCache(uniqueRaw, signal);
    return true;
  }

  /**
   * Summary status click: first page (10 rows); more load on scroll via loadNextPage.
   */
  async function loadAssetsForSelectedStatus() {
    try {
      await ensureRouteScopeResolved(state.sessionAbort?.signal);
    } catch (error) {
      if (error && error.name === "AbortError") return;
      throw error;
    }
    if (shouldHardBlockAssetFetch()) return;

    lastLoadTriggeredAt = Date.now();
    state.sessionAbort?.abort();
    state.sessionAbort = new AbortController();
    const signal = state.sessionAbort.signal;
    state.requestVersion += 1;
    state.listRequestId += 1;
    const loadSessionVersion = state.requestVersion;

    setBusy(true);
    clearError();
    clearLoadMoreHint();
    resetPaginationState();

    try {
      const effectiveStatus = state.selectedStatus === "GrossTotal" ? "" : state.selectedStatus;
      const firstPage = await findWorkingAssetQueryAndFetchPage(signal, effectiveStatus);
      await commitFirstAssetPage(signal, effectiveStatus, firstPage, loadSessionVersion);
    } catch (error) {
      if (error.name === "AbortError") return;
      showError(`Unable to load assets right now. ${error.message || ""}`.trim());
      state.apiRows = [];
      state.allRows = [];
      state.filteredRows = [];
      state.assetsHasMore = false;
      state.hasLoadedOnce = true;
      rebuildAllRows();
    } finally {
      setBusy(false);
    }
  }

  async function appendUniqueAssetRows(uniqueRaw, signal, myListId, myVersion) {
    await mergeEmployeesFromRows(uniqueRaw, signal);
    if (myListId !== state.listRequestId || myVersion !== state.requestVersion) return false;
    uniqueRaw.forEach((rawRow) => {
      const key = getRecordKeyFromRow(rawRow);
      if (!key) return;
      state.rawRowsByRecordKey[key] = rawRow;
    });
    const formatted = uniqueRaw.map((r) => formatRow(r, state.employeesMap));
    state.apiRows = state.apiRows.concat(formatted);
    await warmAssetManagerGuidCache(uniqueRaw, signal);
    return true;
  }

  function getApiSortParams() {
    if (String(state.searchQuery || "").trim()) {
      return { orderBy: "RecordID", isAscending: "true" };
    }
    const currentSort = state.sortState || {};
    if (currentSort.columnKey && currentSort.direction) {
      return {
        orderBy: "",
        isAscending: "true"
      };
    }
    return {
      orderBy: "CreatedDate,Created Date,ModifiedDate,Modified Date",
      isAscending: "false"
    };
  }

  /** Payload for `api/rnsp`; CategoryFilter/TypeFilter come from the route (category/type query params), ItemStatusFilter from the selected status card ("All" for GrossTotal/no selection - the default "total assets" view), PageNumber/PageSize from pagination state (page size defaults to the route's `count` param, see getAssetListFetchPageSize). */
  function buildAssetListRnspPayload(apiPage, apiPageSize, effectiveStatus) {
    const itemStatusFilter = String(effectiveStatus || "").trim();
    return {
      Name: ASSET_LIST_RNSP_NAME,
      Args: {
        CategoryFilter: String(state.categoryId || "").trim(),
        TypeFilter: String(state.typeId || "").trim(),
        ItemStatusFilter: itemStatusFilter || "All",
        PageNumber: String(apiPage),
        PageSize: String(apiPageSize)
      }
    };
  }

  async function fetchAssetsOnce(
    signal,
    objectName,
    whereClause,
    requestedFields,
    apiPage,
    apiPageSize,
    effectiveStatus,
    fetchOptions
  ) {
    const payload = await postJson(
      `${getAppApiBase()}/api/rnsp`,
      buildAssetListRnspPayload(apiPage, apiPageSize, effectiveStatus),
      signal
    );

    const normalized = normalizeRecords(payload).map((row) => normalizeAssetListRow(row));
    const rows = filterAssetRowsForRoute(normalized, effectiveStatus);
    const totalRecords = getTotalRecordsFromPayload(payload);
    if (totalRecords != null) state.assetsTotalRecords = totalRecords;
    return { rows, rawCount: normalized.length, totalRecords };
  }

  async function findWorkingAssetQueryAndFetchPage(signal, effectiveStatus, fetchOptions) {
    if (shouldHardBlockAssetFetch()) {
      return { rows: [], rawCount: 0, objectName: MASTER_LIST_OBJECT_NAME, whereClause: "" };
    }
    const cacheKey = assetQueryCacheKey(effectiveStatus);
    const requestedFields = getAssetRequestedFieldList();
    const objectName = MASTER_LIST_OBJECT_NAME;
    const whereClause = buildAssetMasterListWhereClause(effectiveStatus);

    const result = await fetchAssetsOnce(
      signal,
      objectName,
      whereClause,
      requestedFields,
      1,
      getAssetListFetchPageSize(),
      effectiveStatus,
      fetchOptions
    );
    assetQueryPathCache.set(cacheKey, { objectName, whereClause });
    return { ...result, objectName, whereClause };
  }

  async function fetchNextAssetsPage(signal, effectiveStatus, apiPage, fetchOptions) {
    if (shouldHardBlockAssetFetch()) {
      return { rows: [], rawCount: 0 };
    }
    const cacheKey = assetQueryCacheKey(effectiveStatus);
    const cached = assetQueryPathCache.get(cacheKey);
    if (!cached) {
      return { rows: [], rawCount: 0 };
    }
    const requestedFields = getAssetRequestedFieldList();
    return fetchAssetsOnce(
      signal,
      cached.objectName,
      cached.whereClause,
      requestedFields,
      apiPage,
      getAssetListFetchPageSize(),
      effectiveStatus,
      fetchOptions
    );
  }

  function resetPaginationState() {
    assetQueryPathCache.clear();
    state.seenRecordKeys = new Set();
    state.nextApiPage = 1;
    state.assetsHasMore = true;
    state.assetsLoading = false;
    state.apiRows = [];
    if (!String(state.searchQuery || "").trim()) {
      state.employeesMap = {};
    }
    state.rawRowsByRecordKey = {};
    resetColumnWidthsForFreshData();
  }

  async function loadData(options) {
    const opts = options && typeof options === "object" ? options : {};
    const refreshAfterSave = Boolean(opts.refreshAfterSave);
    const skipSroa = refreshAfterSave ? false : Boolean(opts.skipSroa);
    const assetFetchOptions = refreshAfterSave ? { forceGetRecordsForFields: true } : undefined;
    lastLoadTriggeredAt = Date.now();
    state.sessionAbort?.abort();
    state.sessionAbort = new AbortController();
    const signal = state.sessionAbort.signal;

    state.requestVersion += 1;
    state.listRequestId += 1;
    const loadSessionVersion = state.requestVersion;

    state.localRows = [];
    resetPaginationState();
    setBusy(true);
    clearError();
    clearLoadMoreHint();

    try {
      await ensureRouteScopeResolved(signal);
      if (loadSessionVersion !== state.requestVersion) return;

      if (shouldHardBlockAssetFetch()) {
        state.statusSummary = [];
        buildStatusCards();
        state.apiRows = [];
        state.allRows = [];
        state.filteredRows = [];
        state.assetsHasMore = false;
        state.nextApiPage = 1;
        state.hasLoadedOnce = true;
        renderTableHead();
        renderTable();
        return;
      }

      await loadDynamicColumnsFromView(signal);
      if (loadSessionVersion !== state.requestVersion) return;
      resetColumnWidthsForFreshData();
      renderTableHead();
      renderTable();

      // Item-status summary counts (Summary cards) via api/rnsp. Not needed when only the
      // table status filter changes - those totals are unchanged; skip to avoid an extra API call per click.
      const effectiveStatus = state.selectedStatus === "GrossTotal" ? "" : state.selectedStatus;
      let firstPage;
      if (skipSroa) {
        firstPage = await findWorkingAssetQueryAndFetchPage(signal, effectiveStatus, assetFetchOptions);
        if (loadSessionVersion !== state.requestVersion) return;
      } else {
        const [statusResult, fp] = await Promise.allSettled([
          postJson(`${getAppApiBase()}/api/rnsp`, buildItemStatusRnspPayload(), signal),
          findWorkingAssetQueryAndFetchPage(signal, effectiveStatus, assetFetchOptions)
        ]);
        if (fp.status === "rejected") throw fp.reason;
        firstPage = fp.value;
        if (loadSessionVersion !== state.requestVersion) return;
        state.statusSummary =
          statusResult.status === "fulfilled"
            ? normalizeStatusSummary(extractStatusWithNumber(statusResult.value))
            : [];
      }

      if (loadSessionVersion !== state.requestVersion) return;

      buildStatusCards();

      if (refreshAfterSave) {
        await refreshEmployeesMapFromApi(signal);
      }
      if (loadSessionVersion !== state.requestVersion) return;
      await commitFirstAssetPage(signal, effectiveStatus, firstPage, loadSessionVersion);
    } catch (error) {
      if (error.name === "AbortError") return;
      showError(`Unable to load assets right now. ${error.message || ""}`.trim());
      state.statusSummary = [];
      state.apiRows = [];
      state.allRows = [];
      state.filteredRows = [];
      state.hasLoadedOnce = true;
      buildStatusCards();
      renderTable();
    } finally {
      try {
        lastCompletedDataLoadLocation = `${window.location.pathname || ""}${window.location.search || ""}`;
      } catch (_e) {
        lastCompletedDataLoadLocation = "";
      }
      applyCsSettingButtonTheme();
      setBusy(false);
      if (releasePreloadAfterLoad) {
        syncPortalLayoutOffsets();
        requestAnimationFrame(() => {
          syncPortalLayoutOffsets();
          requestAnimationFrame(() => {
            document.documentElement.classList.remove(PRELOAD_CLASS);
            releasePreloadAfterLoad = false;
          });
        });
      }
    }
  }

  /**
   * Post-save refresh ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â same pattern as inventory.js loadAndRender(true).
   * Reloads the item-status summary, EAsset_Master (both via api/rnsp), and QAF_Users, then updates the UI.
   */
  function loadDataAfterSave() {
    if (!isAssetDetailsRuntimeContext()) return;
    if (!pageInitialized) {
      init();
      return;
    }
    lastPortalTopbarPx = -1;
    document.documentElement.classList.add(PRELOAD_CLASS);
    releasePreloadAfterLoad = true;
    return loadData({ refreshAfterSave: true });
  }

  function refreshAssetDetailsDataLikeDelete() {
    if (!isAssetDetailsRuntimeContext()) return;
    if (!pageInitialized) {
      init();
      return;
    }
    lastPortalTopbarPx = -1;
    document.documentElement.classList.add(PRELOAD_CLASS);
    releasePreloadAfterLoad = true;
    return loadData();
  }

  function runTabSwitchEquivalentDataRefresh() {
    return loadDataAfterSave();
  }

  function refreshAssetDataAfterSave() {
    return loadDataAfterSave();
  }

  function refreshAssetTableAfterCreate() {
    return loadDataAfterSave();
  }

  async function loadNextPage() {
    if (shouldHardBlockAssetFetch() || state.assetsLoading || !state.assetsHasMore) return;

    const effectiveStatus = state.selectedStatus === "GrossTotal" ? "" : state.selectedStatus;
    const cacheKey = assetQueryCacheKey(effectiveStatus);
    if (!assetQueryPathCache.get(cacheKey)) {
      state.assetsHasMore = false;
      return;
    }

    state.assetsLoading = true;
    state.listRequestId += 1;
    const myListId = state.listRequestId;
    const myVersion = state.requestVersion;

    const signal = state.sessionAbort ? state.sessionAbort.signal : undefined;
    if (!signal) {
      state.assetsLoading = false;
      return;
    }

    try {
      const pageJustFetched = state.nextApiPage;
      const { rows, rawCount, totalRecords } = await fetchNextAssetsPage(
        signal,
        effectiveStatus,
        pageJustFetched,
        undefined
      );

      if (myListId !== state.listRequestId || myVersion !== state.requestVersion) return;

      state.nextApiPage += 1;
      state.assetsHasMore = shouldShowMoreAssetPages(rawCount, totalRecords, pageJustFetched);

      const uniqueRaw = filterNewRawRowsByDedupe(rows);
      if (uniqueRaw.length) {
        const appended = await appendUniqueAssetRows(uniqueRaw, signal, myListId, myVersion);
        if (!appended) return;
      }

      clearLoadMoreHint();
      rebuildAllRows();
    } catch (error) {
      if (error.name === "AbortError") return;
      showLoadMoreHint("Could not load more. Scroll down to try again.");
    } finally {
      state.assetsLoading = false;
    }
  }

  function isColumnCurrencyForExport(column) {
    if (!column) return false;
    if (column.isCurrency === true) return true;
    return isCurrencyFieldMeta(getFieldMetaForColumnKey(column.key));
  }

  function formatExportCellValue(row, column, currencyIcon) {
    const displayValue = row[column.key] || "";
    if (!isColumnCurrencyForExport(column)) return displayValue;
    const rawValue =
      row.__sortValues && Object.prototype.hasOwnProperty.call(row.__sortValues, column.key)
        ? row.__sortValues[column.key]
        : stripCurrencyDisplayValue(displayValue);
    return formatCurrencyFieldValue(rawValue, currencyIcon);
  }

  function exportCsv() {
    const activeColumns = getActiveColumnDefs();
    const headers = activeColumns.map((column) => column.label);
    const csvRows = [headers.join(",")];
    const currencyIcon = getStoredCurrencyIcon();
    state.filteredRows.forEach((row) => {
      csvRows.push(
        activeColumns.map((column) => formatExportCellValue(row, column, currencyIcon))
          .map((cell) => `"${String(cell || "").replace(/"/g, '""')}"`)
          .join(",")
      );
    });

    const csvText = "\uFEFF" + csvRows.join("\n");
    const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `assets-${state.categoryLabel.toLowerCase().replace(/\s+/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function closeActiveCellEditor() {
    if (!state.activeEditCell) return;
    const { td, originalHtml } = state.activeEditCell;
    if (td && td.isConnected) {
      td.innerHTML = originalHtml;
      td.classList.remove("is-inline-editing");
    }
    state.activeEditCell = null;
  }

  function buildLookupSelect(columnKey, currentDisplayValue, lookupOptions) {
    const select = document.createElement("select");
    select.className = "inline-cell-input";
    const labelToRaw = getLookupLabelToRawValueMap(columnKey);
    if (columnKey === "ItemStatus") {
      STATUS_ORDER.forEach((status) => {
        if (status === "GrossTotal") return;
        if (!labelToRaw[status]) labelToRaw[status] = status;
      });
    }
    (Array.isArray(lookupOptions) ? lookupOptions : []).forEach((option) => {
      if (!option || !option.label || !option.rawValue) return;
      if (!labelToRaw[option.label]) labelToRaw[option.label] = option.rawValue;
    });
    const labels = Object.keys(labelToRaw).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );
    if (currentDisplayValue && !labelToRaw[currentDisplayValue]) {
      labels.unshift(currentDisplayValue);
      labelToRaw[currentDisplayValue] = currentDisplayValue;
    }
    labels.forEach((label) => {
      const option = document.createElement("option");
      option.value = label;
      option.textContent = label;
      select.appendChild(option);
    });
    select.value = currentDisplayValue || "";
    return { editor: select, labelToRaw };
  }

  function normalizeDateInputValue(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    const slashMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (slashMatch) {
      const dd = String(slashMatch[1]).padStart(2, "0");
      const mm = String(slashMatch[2]).padStart(2, "0");
      const yyyy = slashMatch[3];
      return `${yyyy}-${mm}-${dd}`;
    }
    const zoned = toUserZonedDate(text);
    if (!zoned) return "";
    const yyyy = zoned.getUTCFullYear();
    const mm = String(zoned.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(zoned.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  async function buildEditorForCell(columnKey, currentDisplayValue, signal) {
    const doubleTapInternalName = getInternalNameForColumnKey(columnKey);
    const doubleTapDataType = getDoubleTapDataTypeForInternalName(doubleTapInternalName);
    if (doubleTapDataType === "Employee" || doubleTapDataType === "Team") {
      const data = await fetchDoubleTapLookupData(signal);
      const lookupOptions = buildOptionsFromDoubleTapBucket(data, doubleTapDataType);
      const { editor, labelToRaw } = buildLookupSelect(columnKey, currentDisplayValue, lookupOptions);
      return { editor, labelToRaw };
    }
    const meta = getFieldMetaForColumnKey(columnKey);
    if (isLookupField(meta)) {
      const lookupOptions = await fetchLookupOptionsForMeta(meta, signal);
      const { editor, labelToRaw } = buildLookupSelect(columnKey, currentDisplayValue, lookupOptions);
      return { editor, labelToRaw };
    }
    const input = document.createElement("input");
    input.className = "inline-cell-input";
    input.type = "text";
    if (isNumericField(meta) || isCurrencyFieldMeta(meta)) input.type = "number";
    if (isDateFieldMeta(meta)) {
      input.type = "date";
      input.value = normalizeDateInputValue(currentDisplayValue);
    } else if (isCurrencyFieldMeta(meta)) {
      input.value = stripCurrencyDisplayValue(currentDisplayValue);
    } else {
      input.value = currentDisplayValue || "";
    }
    return { editor: input, labelToRaw: null };
  }

  function validateInlineValue(columnKey, displayValue) {
    const meta = getFieldMetaForColumnKey(columnKey);
    const trimmed = String(displayValue || "").trim();
    if (meta && meta.required && !trimmed) {
      throw new Error(`${columnKey} cannot be blank.`);
    }
  }

  async function saveInlineCellEdit(recordKey, columnKey, displayValue, labelToRaw, signal) {
    const rawRow = state.rawRowsByRecordKey[recordKey];
    if (!rawRow) {
      throw new Error("Unable to locate the record being edited.");
    }
    const recordID = getRecordIDFromRow(rawRow) || getRecordIdFromRecordKey(recordKey);
    if (!recordID) {
      throw new Error("Unable to determine the record ID for this update.");
    }

    const finalDisplay = String(displayValue || "").trim();
    validateInlineValue(columnKey, finalDisplay);
    const nextRawValue = labelToRaw && finalDisplay ? labelToRaw[finalDisplay] || finalDisplay : finalDisplay;
    const nextRawValueText = String(nextRawValue == null ? "" : nextRawValue).trim();

    const fieldName = getEditableFieldNameForColumn(columnKey, rawRow);
    const previousRawValueText = String(rawRow[fieldName] == null ? "" : rawRow[fieldName]).trim();

    // Only call the update workflow when the value actually changed.
    if (previousRawValueText !== nextRawValueText) {
      await updateEAssetMasterField(recordID, fieldName, nextRawValueText, signal);
      rawRow[fieldName] = nextRawValueText;
      state.rawRowsByRecordKey[recordKey] = rawRow;
    }

    // Patch local state and re-render instead of a full reload - no page flash, position preserved.
    applyLocalRowUpdateAfterSave(recordKey, rawRow);
  }

  async function startInlineEdit(td) {
    const columnKey = String(td.getAttribute("data-column-key") || "").trim();
    const recordKey = String(td.getAttribute("data-record-key") || "").trim();
    const editable = td.getAttribute("data-editable") === "true";
    if (!columnKey || !recordKey || !editable || !isCellEditable(columnKey, recordKey)) return;
    if (!canEditAsset(getPermissionRawRowByRecordKey(recordKey))) return;

    closeActiveCellEditor();
    clearError();
    const originalHtml = td.innerHTML;
    const currentText = td.textContent ? td.textContent.trim() : "";
    const { editor, labelToRaw } = await buildEditorForCell(
      columnKey,
      currentText,
      state.sessionAbort && state.sessionAbort.signal
    );
    td.innerHTML = "";
    td.classList.add("is-inline-editing");
    td.appendChild(editor);
    editor.focus();
    if (typeof editor.select === "function") editor.select();

    let isClosing = false;
    const cancel = () => {
      if (isClosing) return;
      isClosing = true;
      closeActiveCellEditor();
    };
    const commit = async () => {
      if (isClosing) return;
      isClosing = true;
      editor.disabled = true;
      try {
        const nextDisplayValue = editor.value;
        await saveInlineCellEdit(recordKey, columnKey, nextDisplayValue, labelToRaw, state.sessionAbort && state.sessionAbort.signal);
      } catch (error) {
        showError(`Unable to update ${columnKey}. ${error.message || ""}`.trim());
        td.innerHTML = originalHtml;
      } finally {
        td.classList.remove("is-inline-editing");
        state.activeEditCell = null;
      }
    };

    editor.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      }
    });

    // Save is explicitly Enter-only; do not auto-save on blur/change.

    state.activeEditCell = { td, originalHtml };
  }

  function attachEvents() {
    if (eventsBound) return;
    eventsBound = true;
    bindRowMenuScrollDismiss();
    ui.statusCards?.addEventListener("click", (event) => {
      const statusButton = event.target.closest("[data-status]");
      if (!statusButton) return;
      const status = toCanonicalStatus(String(statusButton.getAttribute("data-status") || ""));
      // Tapping the active card again clears the filter, so the grid falls back to
      // the default unfiltered pagination.
      const isAlreadySelected =
        !!state.selectedStatus &&
        normalizeStatusToken(status) === normalizeStatusToken(state.selectedStatus);
      state.selectedStatus = isAlreadySelected ? "" : status;
      buildStatusCards();
      loadAssetsForSelectedStatus();
    });
    ui.tableHeadRow?.addEventListener("click", (event) => {
      if (event.target.closest(".gt-col-resizer")) return;
      const header = event.target.closest("th[data-sort-key]");
      if (!header) return;
      const columnKey = header.getAttribute("data-sort-key");
      const columnIndex = Number(header.getAttribute("data-sort-index"));
      if (!columnKey || !Number.isFinite(columnIndex)) return;
      updateSortState(columnIndex, columnKey);
      renderTableHead();
      rebuildAllRows();
    });
    ui.newAssetBtn?.addEventListener("click", () => {
      if (isToolbarCreationRestricted()) return;
      clearError();
      openEAssetMasterNewRecordOutOfBoxForm().catch((error) => {
        showError(`Unable to open new asset form. ${error.message || ""}`.trim());
      });
    });
    ui.moreBtn?.addEventListener("click", () => {
      if (isToolbarCreationRestricted()) return;
      if (ui.moreMenu.hidden) {
        openMoreMenu();
      } else {
        closeMoreMenu();
      }
    });
    ui.moreImportBtn?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeMoreMenu();
      clearError();
      openOutOfBoxBulkImport().catch((error) => {
        showError(`Unable to open import form. ${error.message || ""}`.trim());
      });
    });
    ui.moreExportBtn?.addEventListener("click", () => {
      closeMoreMenu();
      exportCsv();
    });
    const syncAssetSearchClearBtn = () => {
      const wrap = ui.assetSearchInput?.closest(".adetail-search-wrap");
      const hasTypedText = String(ui.assetSearchInput?.value || "").length > 0;
      if (wrap) wrap.classList.toggle("has-value", hasTypedText);
      if (ui.assetSearchClear) ui.assetSearchClear.hidden = !hasTypedText;
    };
    const runAssetSearch = () => {
      state.searchQuery = (ui.assetSearchInput && ui.assetSearchInput.value.trim()) || "";
      loadData({ skipSroa: true });
    };
    const clearAssetSearch = () => {
      if (!ui.assetSearchInput) return;
      const hadSearch = Boolean(String(state.searchQuery || "").trim());
      ui.assetSearchInput.value = "";
      syncAssetSearchClearBtn();
      if (!hadSearch) {
        ui.assetSearchInput.focus();
        return;
      }
      state.searchQuery = "";
      clearError();
      loadData({ skipSroa: true });
      ui.assetSearchInput.focus();
    };
    ui.assetSearchSubmit?.addEventListener("click", () => {
      clearError();
      runAssetSearch();
    });
    ui.assetSearchClear?.addEventListener("click", () => {
      clearAssetSearch();
    });
    ui.assetSearchInput?.addEventListener("input", syncAssetSearchClearBtn);
    // `search` fires once when the user commits (Enter) on type="search"; avoids duplicate
    // loads if we also listened for keydown Enter (some browsers fire both).
    ui.assetSearchInput?.addEventListener("search", () => {
      syncAssetSearchClearBtn();
      clearError();
      runAssetSearch();
    });
    syncAssetSearchClearBtn();
    ui.tableBody?.addEventListener("click", (event) => {
      const serialLink = event.target.closest("a[data-row-view-link='true']");
      if (serialLink) {
        const recordKey = String(serialLink.getAttribute("data-record-key") || "").trim();
        if (!recordKey) return;
        const allowDefaultNavigation =
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey ||
          event.button !== 0;
        if (allowDefaultNavigation) {
          const row = state.filteredRows.find((item) => item && item.__recordKey === recordKey);
          if (row) persistSelectedAssetForSummary(row);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        Promise.resolve(openSerialDetailsPage(recordKey)).catch((error) => {
          showError(`Unable to complete action. ${error.message || ""}`.trim());
        });
        return;
      }
      const toggleButton = event.target.closest("button[data-row-menu-toggle]");
      if (toggleButton) {
        event.preventDefault();
        event.stopPropagation();
        const recordKey = String(toggleButton.getAttribute("data-record-key") || "");
        if (!recordKey) return;
        state.activeRowMenuRecordKey =
          state.activeRowMenuRecordKey === recordKey ? null : recordKey;
        renderTable();
        return;
      }
      const actionButton = event.target.closest("button[data-row-action]");
      if (!actionButton) return;
      event.preventDefault();
      event.stopPropagation();
      const actionKey = String(actionButton.getAttribute("data-row-action") || "").trim().toLowerCase();
      const recordKey = String(actionButton.getAttribute("data-record-key") || "").trim();
      if (!actionKey || !recordKey) return;
      state.activeRowMenuRecordKey = null;
      renderTable();
      handleRowAction(actionKey, recordKey).catch((error) => {
        showError(`Unable to complete action. ${error.message || ""}`.trim());
      });
    });
    const editableCellSelector = 'td[data-column-key][data-record-key][data-editable="true"]';
    const openInlineEditFromEvent = (event) => {
      const td = event.target.closest(editableCellSelector);
      if (!td || !ui.tableBody || !ui.tableBody.contains(td)) return false;
      event.preventDefault();
      startInlineEdit(td).catch((error) => {
        showError(`Unable to open editor. ${error.message || ""}`.trim());
      });
      return true;
    };
    let lastInlineEditTap = { cell: null, at: 0 };
    const handleInlineEditTap = (event) => {
      const td = event.target.closest(editableCellSelector);
      if (!td || !ui.tableBody || !ui.tableBody.contains(td)) return;
      const now = Date.now();
      if (lastInlineEditTap.cell === td && now - lastInlineEditTap.at <= 500) {
        lastInlineEditTap = { cell: null, at: 0 };
        openInlineEditFromEvent(event);
        return;
      }
      lastInlineEditTap = { cell: td, at: now };
    };
    ui.tableBody?.addEventListener("dblclick", (event) => {
      openInlineEditFromEvent(event);
    });
    ui.tableBody?.addEventListener("pointerup", (event) => {
      if (event.pointerType === "mouse") return;
      handleInlineEditTap(event);
    });
    if (!window.PointerEvent) {
      ui.tableBody?.addEventListener("touchend", handleInlineEditTap);
    }
    document.addEventListener("click", (event) => {
      if (ui.moreMenu && ui.moreBtn && !ui.moreMenu.contains(event.target) && !ui.moreBtn.contains(event.target)) {
        closeMoreMenu();
      }
      if (!event.target.closest(".row-actions")) {
        closeRowActionMenu();
      }
      if (
        state.activeEditCell &&
        state.activeEditCell.td &&
        !state.activeEditCell.td.contains(event.target)
      ) {
        closeActiveCellEditor();
      }
    });
    window.addEventListener("resize", positionOpenRowActionMenu);
  }

  function applyRouteContext() {
    const mounted = ensureAppMarkup();
    if (!mounted) return false;
    refreshUiRefs();
    if (
      !ui.main ||
      !ui.tableWrap ||
      !ui.tableElement ||
      !ui.tableHeadRow ||
      !ui.tableBody ||
      !ui.tableColGroup
    ) {
      return false;
    }
    const params = getRouteParams();
    const nextRouteSignature = [
      params.categoryId,
      params.categoryName,
      params.typeId,
      params.typeName,
      params.assetCount == null ? "" : params.assetCount
    ].join("|");
    const routeChanged = nextRouteSignature !== activeRouteSignature;
    activeRouteSignature = nextRouteSignature;
    state.categoryId = params.categoryId;
    state.categoryLabel = params.categoryName;
    state.typeId = params.typeId;
    state.typeLabel = params.typeName;
    state.routeAssetCount = params.assetCount;
    state.routeHasZeroAssets = params.assetCount === 0;
    if (ui.pageTitle) {
      const titleLabel = String(state.categoryLabel || DEFAULT_CATEGORY_LABEL).trim();
      ui.pageTitle.textContent = `${titleLabel} Assets`;
    }
    if (routeChanged) {
      state.searchQuery = "";
      if (ui.assetSearchInput) ui.assetSearchInput.value = "";
      const wrap = ui.assetSearchInput?.closest(".adetail-search-wrap");
      if (wrap) wrap.classList.remove("has-value");
      if (ui.assetSearchClear) ui.assetSearchClear.hidden = true;
      // Item-status filter is scoped to the selected Type/Category; a new selection starts unfiltered.
      state.selectedStatus = "";
    }
    return routeChanged;
  }

  function init() {
    if (!isPageAuthorized()) {
      try {
        document.documentElement.style.visibility = "hidden";
      } catch (_error) {
        // Ignore.
      }
      window.location.replace(buildUnauthorizedRedirectUrl());
      return false;
    }
    if (!isAssetDetailsRuntimeContext()) {
      document.documentElement.classList.remove(PRELOAD_CLASS);
      return false;
    }
    const routeChanged = applyRouteContext();
    const shouldRefreshOnReturn = consumeRefreshOnReturnFlag();
    if (routeChanged === false && !pageInitialized) return false;
    if (pageInitialized) {
      // Prevent repeated boot listeners from triggering duplicate API loads.
      syncRestrictedToolbarButtons();
      if (shouldRefreshOnReturn) {
        runTabSwitchEquivalentDataRefresh();
      } else {
        syncPortalLayoutOffsets();
        requestAnimationFrame(() => {
          syncPortalLayoutOffsets();
          document.documentElement.classList.remove(PRELOAD_CLASS);
        });
      }
      return true;
    }
    if (typeof window.renderNavDock === "function") window.renderNavDock();
    syncPortalLayoutOffsets();
    if (!pageInitialized) {
      window.addEventListener("resize", scheduleSyncPortalLayoutOffsets);
    }
    renderTableHead();
    attachEvents();
    syncRestrictedToolbarButtons();
    applyCsSettingButtonTheme();
    setupTableLazyLoading();
    releasePreloadAfterLoad = true;
    loadData().finally(() => {
      setupTableLazyLoading();
      notifyAssetTableScrollLayout();
    });
    pageInitialized = true;
    return true;
  }

  function scheduleBootRetries() {
    [0, 80, 200, 500, 1000, 1800].forEach((delay) => {
      window.setTimeout(() => {
        init();
      }, delay);
    });
  }

  /*
   * `trigger` is "visibility" for a plain tab switch and "navigation" for a real
   * return to the page (bfcache restore or SPA route change). Coming back to the
   * tab must leave the rendered page alone, so the two things that made it flash
   * are gated on the trigger:
   *
   *   - the refresh-on-return flag. It is only ever set just before a same-tab
   *     window.location.assign, and such a navigation always comes back as a
   *     fresh document (init() consumes it there) or as a pageshow. But in-page
   *     portal forms set the flag too and never navigate, so the flag was left
   *     behind and the next tab switch cashed it in - blanking the page behind
   *     PRELOAD_CLASS and re-running every API. In-page saves do not rely on the
   *     flag; they call loadDataAfterSave() directly.
   *   - renderNavDock(), which rebuilds the dock's innerHTML from scratch. That
   *     teardown/rebuild is a visible flicker in itself, even when no reload
   *     followed it.
   */
  function handleRouteOrVisibilityRefresh(trigger) {
    if (!pageInitialized) {
      init();
      return;
    }
    const isTabFocus = trigger === "visibility";
    const routeChanged = applyRouteContext();
    // Cheap and cached - only writes the CSS var when the offset really moved.
    syncPortalLayoutOffsets();
    if (!isTabFocus || routeChanged) {
      if (typeof window.renderNavDock === "function") window.renderNavDock();
    }
    let locationKey = "";
    try {
      locationKey = `${window.location.pathname || ""}${window.location.search || ""}`;
    } catch (_e) {
      locationKey = "";
    }

    // Consume the refresh-on-return flag here so that returning from the
    // Save form (which navigates away via window.location.assign and back)
    // triggers a full data reload even when the URL is identical to the
    // URL before navigation. Previously this flag was only consumed in
    // init(), but init() is not called on pageshow/visibilitychange when
    // pageInitialized is already true, so post-SaveRecord navigations
    // never triggered the refresh APIs (api/rnsp for the asset list and
    // item-status summary, QAF_Users). The Delete flow works without this because it uses a
    // QafPageService callback and never navigates away from the page.
    const shouldRefreshOnReturn = !isTabFocus && consumeRefreshOnReturnFlag();
    if (shouldRefreshOnReturn) {
      runTabSwitchEquivalentDataRefresh();
      return;
    }

    // Same URL with data already loaded: tab/window focus or bfcache
    // restore - layout only, no API reload.
    if (
      state.hasLoadedOnce &&
      lastCompletedDataLoadLocation &&
      locationKey === lastCompletedDataLoadLocation
    ) {
      return;
    }
    if (!routeChanged) return;
    lastPortalTopbarPx = -1;
    document.documentElement.classList.add(PRELOAD_CLASS);
    releasePreloadAfterLoad = true;
    loadData();
  }

  if (!isPageAuthorized()) {
    try {
      document.documentElement.style.visibility = "hidden";
    } catch (_error) {
      // Ignore.
    }
    window.location.replace(buildUnauthorizedRedirectUrl());
  } else {
    scheduleBootRetries();
    window.addEventListener("DOMContentLoaded", () => init());
    window.addEventListener("load", () => init());
    window.addEventListener("pageshow", () => {
      // Real return to the document (including bfcache restore): still no API
      // reload when the URL is unchanged, but a pending refresh-on-return counts.
      handleRouteOrVisibilityRefresh("navigation");
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        // Tab switch only - must not reload or re-render anything.
        handleRouteOrVisibilityRefresh("visibility");
      }
    });
    window.addEventListener("hashchange", () => handleRouteOrVisibilityRefresh("navigation"));
    window.addEventListener("popstate", () => handleRouteOrVisibilityRefresh("navigation"));
  }

  window.qafAssetDetailsLoadAfterSave = loadDataAfterSave;
  window.qafAssetDetailsRefreshAfterSave = loadDataAfterSave;
})();