// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Locally, talk to glist-backend on port 3000. In production the Netlify site proxies
// /api/* to the Vercel backend (see netlify.toml), so requests are same-origin and the
// session cookie is first-party.
const IS_LOCAL_DEV = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
const API_URL = IS_LOCAL_DEV ? "http://localhost:3000/api/" : "/api/";

const ACTIVE_LIST_KEY = "glist.activeListId";
const REMOVED_ITEM_RETENTION_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const authForm = $("authForm");
const authError = $("authError");
const listSelector = $("listSelector");
const listView = $("listView");
const noListsView = $("noListsView");
const listTitle = $("listTitle");
const listEyebrow = $("listEyebrow");
const groceryForm = $("groceryForm");
const itemInput = $("itemInput");
const groceryList = $("groceryList");
const emptyMessage = $("emptyMessage");
const viewerNotice = $("viewerNotice");
const itemCount = $("itemCount");
const totalItemCount = $("totalItemCount");
const crossedOffCountLabel = $("crossedOffCount");
const profileMenu = document.querySelector(".profile-menu");
const toast = $("toast");

const listDialog = $("listDialog");
const memberList = $("memberList");
const listDialogError = $("listDialogError");
const adminDialog = $("adminDialog");
const adminUserList = $("adminUserList");
const adminError = $("adminError");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let currentUser = null;
let lists = [];
let activeList = null;
let items = [];
let itemsLoaded = false;
let eventSource = null;
let authMode = "login";
let removedItemExpirationTimer;
const pendingRequestIds = new Set();
const itemsToAnimateIn = new Set();
const itemsToAnimateRemoved = new Set();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

async function api(path, { method = "GET", body, requestId } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (requestId) headers["X-Client-Request-Id"] = requestId;

    let response;
    try {
        response = await fetch(API_URL + path, {
            method,
            headers,
            credentials: "include",
            body: body === undefined ? undefined : JSON.stringify(body)
        });
    } catch {
        throw new ApiError("Can't reach the server. Check your connection and try again.", 0);
    }

    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
        if (response.status === 401 && currentUser && !path.startsWith("auth/")) {
            handleSignedOut("Your session ended. Please sign in again.");
        }
        throw new ApiError(data?.error || `Request failed (${response.status})`, response.status);
    }
    return data;
}

// Small DOM builder: el("button", { className: "x", onclick }, "Text", childNode)
function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([key, value]) => {
        if (value === undefined || value === null || value === false) return;
        if (key === "dataset") Object.assign(node.dataset, value);
        else if (key in node) node[key] = value;
        else node.setAttribute(key, value);
    });
    node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
    return node;
}

let toastTimer;
function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 4000);
}

function setFormError(form, message) {
    const target = form.querySelector(".form-error");
    if (target) target.textContent = message || "";
}

function formatElapsedTime(timestamp) {
    const elapsedHours = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 3600000));
    if (elapsedHours < 1) return "less than an hour ago";
    if (elapsedHours < 24) return `${elapsedHours} ${elapsedHours === 1 ? "hour" : "hours"} ago`;
    const elapsedDays = Math.floor(elapsedHours / 24);
    return `${elapsedDays} ${elapsedDays === 1 ? "day" : "days"} ago`;
}

function plural(count, word) {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Sign in / sign up / sign out
// ---------------------------------------------------------------------------

function setAuthMode(mode) {
    authMode = mode;
    const isRegister = mode === "register";
    $("authTitle").textContent = isRegister ? "Create an account" : "Sign in";
    $("authSubmit").textContent = isRegister ? "Create account" : "Sign in";
    $("authSwitchText").textContent = isRegister ? "Already have an account?" : "New here?";
    $("authSwitch").textContent = isRegister ? "Sign in" : "Create an account";
    $("displayNameField").hidden = !isRegister;
    authForm.elements.display_name.required = isRegister;
    authForm.elements.password.autocomplete = isRegister ? "new-password" : "current-password";
    authError.textContent = "";
}

$("authSwitch").addEventListener("click", () => {
    setAuthMode(authMode === "login" ? "register" : "login");
});

authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = authForm.elements;
    const submit = $("authSubmit");
    authError.textContent = "";

    const body = { email: form.email.value.trim(), password: form.password.value };
    if (authMode === "register") {
        body.display_name = form.display_name.value.trim();
        if (!body.display_name) return void (authError.textContent = "Please enter your name.");
        if (body.password.length < 8) return void (authError.textContent = "Password must be at least 8 characters.");
    }

    submit.disabled = true;
    try {
        const { user } = await api(authMode === "register" ? "auth/register" : "auth/login", {
            method: "POST",
            body
        });
        authForm.reset();
        await setSignedIn(user);
    } catch (error) {
        authError.textContent = error.message;
    } finally {
        submit.disabled = false;
    }
});

async function setSignedIn(user) {
    currentUser = user;
    document.body.classList.remove("is-loading", "is-signed-out");
    document.body.classList.add("is-signed-in");
    renderProfile();
    try {
        await loadLists();
    } catch (error) {
        showToast(`Couldn't load your lists: ${error.message}`);
    }
}

function handleSignedOut(message = "") {
    currentUser = null;
    activeList = null;
    lists = [];
    items = [];
    eventSource?.close();
    eventSource = null;
    clearTimeout(removedItemExpirationTimer);
    document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
    document.body.classList.remove("is-loading", "is-signed-in");
    document.body.classList.add("is-signed-out");
    setAuthMode("login");
    authError.textContent = message;
}

async function signOut() {
    try {
        await api("auth/logout", { method: "POST" });
    } catch (error) {
        console.error("Sign out failed:", error);
    }
    handleSignedOut();
}

function renderProfile() {
    const name = currentUser.display_name || currentUser.email;
    $("profileName").textContent = name;
    $("profileEmail").textContent = currentUser.email;
    $("profileInitial").textContent = name.trim().charAt(0).toUpperCase();
    $("adminMenuButton").hidden = !currentUser.is_admin;
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

async function loadLists(preferredListId = null) {
    const { lists: fetched } = await api("lists");
    lists = fetched;
    renderListSelector();

    if (lists.length === 0) {
        activeList = null;
        eventSource?.close();
        listView.hidden = true;
        noListsView.hidden = false;
        return;
    }

    const wantedId = preferredListId || activeList?.id || localStorage.getItem(ACTIVE_LIST_KEY);
    const next = lists.find((list) => list.id === wantedId) || lists[0];
    await openList(next.id);
}

function renderListSelector() {
    listSelector.replaceChildren(...lists.map((list) => el("option", {
        value: list.id,
        textContent: list.role === "owner" ? list.name : `${list.name} (shared)`
    })));
    listSelector.disabled = lists.length === 0;
    if (activeList) listSelector.value = activeList.id;
}

async function openList(listId) {
    const list = lists.find((candidate) => candidate.id === listId);
    if (!list) return;

    const isSameList = activeList?.id === listId;
    activeList = list;
    localStorage.setItem(ACTIVE_LIST_KEY, listId);
    listSelector.value = listId;
    noListsView.hidden = true;
    listView.hidden = false;

    if (!isSameList) {
        items = [];
        itemsLoaded = false;
        renderItems();
        connectEvents(listId);
    }
    await refreshItems();
}

listSelector.addEventListener("change", () => {
    openList(listSelector.value).catch((error) => showToast(error.message));
});

function renderListHeading() {
    listTitle.textContent = activeList.name;

    const others = activeList.member_count - 1;
    if (activeList.role === "owner") {
        listEyebrow.textContent = others > 0
            ? `SHARED WITH ${others} ${others === 1 ? "PERSON" : "PEOPLE"}`
            : "YOUR SHOPPING SPACE";
    } else {
        listEyebrow.textContent = `SHARED BY ${(activeList.owner_name || "another member").toUpperCase()}`;
    }

    const canEdit = activeList.role !== "viewer";
    groceryForm.hidden = !canEdit;
    viewerNotice.hidden = canEdit;
    $("manageListButton").textContent = activeList.role === "owner" ? "Share & manage" : "List details";
}

// Re-fetches list metadata (name, member counts) without reloading items.
async function refreshListMetadata() {
    const { lists: fetched } = await api("lists");
    lists = fetched;
    const stillThere = activeList && lists.find((list) => list.id === activeList.id);
    if (!stillThere) return loadLists();
    activeList = stillThere;
    renderListSelector();
    renderListHeading();
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function normalizeItem(apiItem) {
    return {
        id: apiItem.id,
        listId: apiItem.list_id,
        name: apiItem.name.trim(),
        created_at: apiItem.created_at || null,
        removed_at: apiItem.removed_at || null,
        added_by_name: apiItem.added_by_name || null,
        removed_by_name: apiItem.removed_by_name || null
    };
}

async function refreshItems() {
    if (!activeList) return;
    const listId = activeList.id;
    const result = await api(`lists/${listId}/items`);
    if (activeList?.id !== listId) return; // switched lists while loading

    if (result.role && result.role !== activeList.role) activeList.role = result.role;
    const pendingItems = items.filter((item) => item.pending);
    items = result.items.map(normalizeItem).filter((item) => item.name).concat(pendingItems);
    itemsLoaded = true;
    renderItems();
}

function renderItems() {
    groceryList.replaceChildren();
    if (!activeList) return;
    renderListHeading();

    const crossedOff = items.filter((item) => item.removed_at).length;
    totalItemCount.textContent = items.length;
    crossedOffCountLabel.textContent = crossedOff;
    itemCount.setAttribute("aria-label", `${plural(items.length, "total item")}, ${crossedOff} crossed off`);

    const canEdit = activeList.role !== "viewer";
    const sortedItems = [
        ...items.filter((item) => !item.removed_at),
        ...items.filter((item) => item.removed_at)
    ];

    sortedItems.forEach((item) => {
        const listItem = el("li", { className: "grocery-item", dataset: { itemId: item.id || "" } });
        if (itemsToAnimateIn.has(item)) {
            listItem.classList.add("is-entering");
            requestAnimationFrame(() => itemsToAnimateIn.delete(item));
        }
        if (itemsToAnimateRemoved.has(item)) {
            listItem.classList.add("is-crossing-off");
            requestAnimationFrame(() => itemsToAnimateRemoved.delete(item));
        }

        const meta = el("p", { className: "item-meta" });
        if (item.removed_at) {
            listItem.classList.add("is-removed");
            meta.append(`Crossed off by ${item.removed_by_name || "a former member"}`);
        } else {
            meta.append(`Added by ${item.added_by_name || "a former member"}`);
            if (item.created_at && Number.isFinite(Date.parse(item.created_at))) {
                meta.append(" · ", el("time", {
                    className: "item-added-time",
                    dateTime: item.created_at,
                    title: `Added ${new Date(item.created_at).toLocaleString()}`,
                    textContent: formatElapsedTime(item.created_at)
                }));
            }
        }

        const details = el("div", { className: "item-details" },
            el("span", {
                className: "item-name",
                textContent: item.name,
                title: item.removed_at ? `Removed ${new Date(item.removed_at).toLocaleString()}` : undefined
            }),
            meta
        );

        listItem.append(details);
        if (canEdit) {
            const removeButton = el("button", {
                type: "button",
                className: "remove-btn",
                textContent: item.removed_at ? "Removed" : "Remove",
                disabled: item.pending === true || Boolean(item.removed_at)
            });
            removeButton.addEventListener("click", () => removeItem(item, removeButton));
            listItem.append(removeButton);
        }
        groceryList.appendChild(listItem);
    });

    emptyMessage.textContent = itemsLoaded ? "This list is empty." : "Loading…";
    emptyMessage.style.display = items.length === 0 ? "block" : "none";
    scheduleRemovedItemExpiration();
}

groceryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = itemInput.value.trim();
    if (!name || !activeList) return;

    const listId = activeList.id;
    const requestId = crypto.randomUUID();
    const item = {
        id: null,
        listId,
        name,
        created_at: new Date().toISOString(),
        added_by_name: currentUser.display_name,
        pending: true,
        requestId
    };
    pendingRequestIds.add(requestId);
    itemsToAnimateIn.add(item);
    items.push(item);
    renderItems();
    itemInput.value = "";
    itemInput.focus();

    try {
        const result = await api(`lists/${listId}/items`, { method: "POST", body: { name }, requestId });
        upsertItem(result.item, requestId);
    } catch (error) {
        const index = items.indexOf(item);
        if (index !== -1) items.splice(index, 1);
        renderItems();
        showToast(`Couldn't add "${name}": ${error.message}`);
    } finally {
        pendingRequestIds.delete(requestId);
    }
});

async function removeItem(item, button) {
    if (!item.id || !activeList) return;
    button.disabled = true;
    const requestId = crypto.randomUUID();
    pendingRequestIds.add(requestId);

    try {
        const result = await api(`lists/${activeList.id}/items/${encodeURIComponent(item.id)}`, {
            method: "DELETE",
            requestId
        });
        markItemRemoved(result.item, item);
    } catch (error) {
        button.disabled = false;
        showToast(`Couldn't remove "${item.name}": ${error.message}`);
    } finally {
        pendingRequestIds.delete(requestId);
    }
}

function upsertItem(apiItem, requestId = null) {
    if (!activeList || apiItem.list_id !== activeList.id) return;
    const incoming = normalizeItem(apiItem);
    const existing = items.find((item) => item.id === incoming.id);
    const pending = requestId ? items.find((item) => item.requestId === requestId) : null;

    if (existing && pending && existing !== pending) {
        items.splice(items.indexOf(pending), 1);
    }
    const target = existing || pending;
    if (target) {
        Object.assign(target, incoming, { pending: false });
        delete target.requestId;
    } else {
        itemsToAnimateIn.add(incoming);
        items.push(incoming);
    }
    renderItems();
}

function markItemRemoved(apiItem, knownItem = null) {
    const target = knownItem || items.find((item) => item.id === apiItem.id);
    if (!target) return;
    Object.assign(target, normalizeItem(apiItem));
    itemsToAnimateRemoved.add(target);
    renderItems();
}

// Crossed-off items disappear 24h after removal; refresh when the next one expires.
function scheduleRemovedItemExpiration() {
    clearTimeout(removedItemExpirationTimer);
    const expiryTimes = items
        .filter((item) => item.removed_at)
        .map((item) => Date.parse(item.removed_at) + REMOVED_ITEM_RETENTION_MS)
        .filter(Number.isFinite);
    if (expiryTimes.length === 0) return;

    removedItemExpirationTimer = setTimeout(() => {
        refreshItems().catch((error) => console.error("Unable to refresh expired items:", error));
    }, Math.max(0, Math.min(...expiryTimes) - Date.now()));
}

setInterval(() => {
    document.querySelectorAll(".item-added-time").forEach((label) => {
        label.textContent = formatElapsedTime(label.dateTime);
    });
}, 60000);

// ---------------------------------------------------------------------------
// Live updates (server-sent events, one stream for the open list)
// ---------------------------------------------------------------------------

let reconnectCheckTimer;

function connectEvents(listId) {
    eventSource?.close();
    clearTimeout(reconnectCheckTimer);

    const source = new EventSource(`${API_URL}lists/${listId}/events`, { withCredentials: true });
    eventSource = source;

    source.addEventListener("open", () => {
        refreshItems().catch((error) => console.error("Unable to refresh items after reconnecting:", error));
    });

    source.addEventListener("list-changed", (event) => {
        try {
            handleListChange(JSON.parse(event.data));
        } catch (error) {
            console.error("Unable to process list update:", error);
        }
    });

    // The browser retries dropped connections by itself. It gives up (CLOSED) when the
    // server refuses, e.g. we were removed from the list or signed out, so re-check then.
    source.addEventListener("error", () => {
        if (source.readyState !== EventSource.CLOSED || eventSource !== source) return;
        reconnectCheckTimer = setTimeout(async () => {
            if (!currentUser || eventSource !== source) return;
            try {
                const { user } = await api("auth/me");
                if (!user) return handleSignedOut("Your session ended. Please sign in again.");
                const stillMember = (await api("lists")).lists.some((list) => list.id === listId);
                if (stillMember) connectEvents(listId);
                else loadLists();
            } catch (error) {
                console.error("Unable to re-check list access:", error);
            }
        }, 3000);
    });
}

function handleListChange(change) {
    if (!activeList || change.listId !== activeList.id) return;
    if (change.requestId && pendingRequestIds.has(change.requestId)) return;

    switch (change.type) {
        case "created":
            upsertItem(change.item, change.requestId);
            break;
        case "removed":
            markItemRemoved(change.item);
            break;
        case "list-updated":
            activeList.name = change.name;
            renderListSelector();
            renderListHeading();
            break;
        case "list-deleted":
            showToast(`"${activeList.name}" was deleted by its owner.`);
            activeList = null;
            loadLists().catch((error) => showToast(error.message));
            break;
        case "members-changed":
            if (change.removedUserId === currentUser.id) {
                showToast(`You no longer have access to "${activeList.name}".`);
                activeList = null;
                loadLists().catch((error) => showToast(error.message));
            } else {
                refreshListMetadata().catch((error) => console.error(error));
                if (listDialog.open) loadMembers();
            }
            break;
        default:
            break;
    }
}

// ---------------------------------------------------------------------------
// New list dialog
// ---------------------------------------------------------------------------

function openNewListDialog() {
    const form = $("newListForm");
    form.reset();
    setFormError(form, "");
    $("newListDialog").showModal();
}

$("newListButton").addEventListener("click", openNewListDialog);
$("firstListButton").addEventListener("click", openNewListDialog);

$("newListForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.elements.name.value.trim();
    if (!name) return;

    try {
        const { list } = await api("lists", { method: "POST", body: { name } });
        $("newListDialog").close();
        await loadLists(list.id);
        showToast(`Created "${list.name}".`);
    } catch (error) {
        setFormError(form, error.message);
    }
});

// ---------------------------------------------------------------------------
// Share & manage dialog
// ---------------------------------------------------------------------------

$("manageListButton").addEventListener("click", () => {
    if (!activeList) return;
    const isOwner = activeList.role === "owner";
    listDialog.classList.toggle("is-owner", isOwner);
    $("listDialogTitle").textContent = activeList.name;
    $("renameListForm").elements.name.value = activeList.name;
    $("addMemberForm").reset();
    listDialogError.textContent = "";
    memberList.replaceChildren(el("li", { className: "muted small", textContent: "Loading…" }));
    listDialog.showModal();
    loadMembers();
});

async function loadMembers() {
    if (!activeList) return;
    try {
        const { members } = await api(`lists/${activeList.id}/members`);
        renderMembers(members);
    } catch (error) {
        listDialogError.textContent = error.message;
    }
}

function renderMembers(members) {
    const isOwner = activeList.role === "owner";
    memberList.replaceChildren(...members.map((member) => {
        const isMe = member.user_id === currentUser.id;
        const who = el("div", { className: "member-who" },
            el("strong", { textContent: `${member.display_name || member.email}${isMe ? " (you)" : ""}` }),
            el("span", { className: "muted small", textContent: member.email })
        );

        let access;
        if (member.role === "owner") {
            access = el("span", { className: "role-badge", textContent: "Owner" });
        } else if (isOwner) {
            access = el("select", { ariaLabel: `Access for ${member.email}` },
                el("option", { value: "editor", textContent: "Can edit", selected: member.role === "editor" }),
                el("option", { value: "viewer", textContent: "Can view", selected: member.role === "viewer" })
            );
            access.addEventListener("change", () => updateMemberRole(member, access.value));
        } else {
            access = el("span", { className: "role-badge", textContent: member.role === "editor" ? "Can edit" : "Can view" });
        }

        const remove = isOwner && member.role !== "owner"
            ? el("button", { type: "button", className: "remove-btn", textContent: "Remove", onclick: () => removeMember(member) })
            : null;

        return el("li", { className: "member-row" }, who, access, remove);
    }));
}

async function updateMemberRole(member, role) {
    listDialogError.textContent = "";
    try {
        const { members } = await api(`lists/${activeList.id}/members/${member.user_id}`, {
            method: "PATCH",
            body: { role }
        });
        renderMembers(members);
    } catch (error) {
        listDialogError.textContent = error.message;
        loadMembers();
    }
}

async function removeMember(member) {
    if (!confirm(`Remove ${member.display_name || member.email} from "${activeList.name}"?`)) return;
    listDialogError.textContent = "";
    try {
        await api(`lists/${activeList.id}/members/${member.user_id}`, { method: "DELETE" });
        await loadMembers();
        await refreshListMetadata();
    } catch (error) {
        listDialogError.textContent = error.message;
    }
}

$("addMemberForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    listDialogError.textContent = "";
    try {
        const { members } = await api(`lists/${activeList.id}/members`, {
            method: "POST",
            body: { email: form.elements.email.value.trim(), role: form.elements.role.value }
        });
        renderMembers(members);
        form.reset();
        await refreshListMetadata();
    } catch (error) {
        listDialogError.textContent = error.message;
    }
});

$("renameListForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = event.currentTarget.elements.name.value.trim();
    if (!name) return;
    listDialogError.textContent = "";
    try {
        const { list } = await api(`lists/${activeList.id}`, { method: "PATCH", body: { name } });
        activeList.name = list.name;
        $("listDialogTitle").textContent = list.name;
        renderListSelector();
        renderListHeading();
        showToast("List renamed.");
    } catch (error) {
        listDialogError.textContent = error.message;
    }
});

$("deleteListButton").addEventListener("click", async () => {
    if (!confirm(`Delete "${activeList.name}" and all its items for everyone on it? This can't be undone.`)) return;
    try {
        const name = activeList.name;
        await api(`lists/${activeList.id}`, { method: "DELETE" });
        listDialog.close();
        activeList = null;
        await loadLists();
        showToast(`Deleted "${name}".`);
    } catch (error) {
        listDialogError.textContent = error.message;
    }
});

$("leaveListButton").addEventListener("click", async () => {
    if (!confirm(`Leave "${activeList.name}"? You'll need the owner to add you again.`)) return;
    try {
        const name = activeList.name;
        await api(`lists/${activeList.id}/members/${currentUser.id}`, { method: "DELETE" });
        listDialog.close();
        activeList = null;
        await loadLists();
        showToast(`You left "${name}".`);
    } catch (error) {
        listDialogError.textContent = error.message;
    }
});

// ---------------------------------------------------------------------------
// Account settings dialog
// ---------------------------------------------------------------------------

function openAccountDialog() {
    const form = $("accountForm");
    form.reset();
    form.elements.display_name.value = currentUser.display_name || "";
    form.elements.email.value = currentUser.email;
    setFormError(form, "");
    $("accountDialog").showModal();
}

$("accountForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = form.elements;
    const body = { display_name: fields.display_name.value.trim() };

    if (fields.new_password.value) {
        if (fields.new_password.value.length < 8) {
            return setFormError(form, "New password must be at least 8 characters.");
        }
        body.current_password = fields.current_password.value;
        body.new_password = fields.new_password.value;
    }

    try {
        const { user } = await api("auth/me", { method: "PATCH", body });
        currentUser = user;
        renderProfile();
        $("accountDialog").close();
        showToast(body.new_password ? "Name and password saved." : "Saved.");
        refreshItems().catch(() => {});
    } catch (error) {
        setFormError(form, error.message);
    }
});

// ---------------------------------------------------------------------------
// Admin dialog
// ---------------------------------------------------------------------------

async function openAdminDialog() {
    adminError.textContent = "";
    adminUserList.replaceChildren(el("li", { className: "muted small", textContent: "Loading…" }));
    adminDialog.showModal();
    await loadAdminUsers();
}

async function loadAdminUsers() {
    try {
        const { users } = await api("admin/users");
        adminUserList.replaceChildren(...users.map(renderAdminUser));
    } catch (error) {
        adminError.textContent = error.message;
    }
}

async function adminUpdate(user, body, successMessage) {
    adminError.textContent = "";
    try {
        const { user: updated } = await api(`admin/users/${user.id}`, { method: "PATCH", body });
        if (updated.id === currentUser.id) {
            currentUser = { ...currentUser, ...updated };
            renderProfile();
        }
        showToast(successMessage);
        return updated;
    } catch (error) {
        adminError.textContent = `${user.email}: ${error.message}`;
        return null;
    }
}

function renderAdminUser(user) {
    const isMe = user.id === currentUser.id;

    const nameInput = el("input", { type: "text", value: user.display_name || "", maxLength: 50, ariaLabel: "Name" });
    const emailInput = el("input", { type: "email", value: user.email, ariaLabel: "Email" });
    const saveButton = el("button", { type: "submit", className: "secondary-btn", textContent: "Save" });
    const detailsForm = el("form", { className: "inline-form" },
        el("label", { className: "grow" }, el("span", { className: "small muted", textContent: "Name" }), nameInput),
        el("label", { className: "grow" }, el("span", { className: "small muted", textContent: "Email" }), emailInput),
        saveButton
    );
    detailsForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const updated = await adminUpdate(user, {
            display_name: nameInput.value.trim(),
            email: emailInput.value.trim()
        }, "User details saved.");
        if (updated) Object.assign(user, updated);
    });

    const toggle = (label, field, disabledReason) => {
        const input = el("input", { type: "checkbox", checked: user[field], disabled: Boolean(disabledReason) });
        input.addEventListener("change", async () => {
            const updated = await adminUpdate(user, { [field]: input.checked }, `${label} ${input.checked ? "on" : "off"} for ${user.email}.`);
            if (updated) Object.assign(user, updated);
            else input.checked = !input.checked;
        });
        return el("label", { className: "toggle", title: disabledReason || "" }, input, ` ${label}`);
    };

    const passwordInput = el("input", { type: "password", placeholder: "New password (8+ chars)", minLength: 8, autocomplete: "new-password", ariaLabel: "New password" });
    const passwordForm = el("form", { className: "inline-form" },
        el("label", { className: "grow" }, passwordInput),
        el("button", { type: "submit", className: "secondary-btn", textContent: "Set password" })
    );
    passwordForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (passwordInput.value.length < 8) {
            adminError.textContent = "Passwords must be at least 8 characters.";
            return;
        }
        if (await adminUpdate(user, { password: passwordInput.value }, `Password changed for ${user.email}. They've been signed out.`)) {
            passwordInput.value = "";
        }
    });

    const deleteButton = el("button", {
        type: "button",
        className: "danger-btn",
        textContent: "Delete user",
        disabled: isMe,
        title: isMe ? "You can't delete your own account here" : ""
    });
    deleteButton.addEventListener("click", async () => {
        if (!confirm(`Delete ${user.email}? Their shared lists go to another member; lists only they use are deleted.`)) return;
        adminError.textContent = "";
        try {
            await api(`admin/users/${user.id}`, { method: "DELETE" });
            showToast(`Deleted ${user.email}.`);
            await loadAdminUsers();
        } catch (error) {
            adminError.textContent = `${user.email}: ${error.message}`;
        }
    });

    const summary = el("p", { className: "small muted" },
        `Joined ${new Date(user.created_at).toLocaleDateString()} · owns ${plural(user.owned_list_count, "list")} · on ${user.shared_list_count} shared`
    );

    return el("li", { className: `admin-user${user.is_disabled ? " is-disabled" : ""}` },
        el("div", { className: "admin-user-head" },
            el("strong", { textContent: `${user.display_name || user.email}${isMe ? " (you)" : ""}` }),
            user.is_admin ? el("span", { className: "role-badge", textContent: "Admin" }) : null,
            user.is_disabled ? el("span", { className: "role-badge is-danger", textContent: "Disabled" }) : null
        ),
        summary,
        detailsForm,
        el("div", { className: "admin-user-actions" },
            toggle("Admin", "is_admin", isMe && "You can't remove your own admin access"),
            toggle("Disabled", "is_disabled", isMe && "You can't disable your own account"),
            deleteButton
        ),
        passwordForm
    );
}

adminDialog.addEventListener("close", () => {
    // Pick up any changes to our own name / lists made from the admin panel.
    if (currentUser) refreshListMetadata().catch(() => {});
});

// ---------------------------------------------------------------------------
// Menus and dialogs
// ---------------------------------------------------------------------------

const menuActions = {
    account: openAccountDialog,
    admin: openAdminDialog,
    about: () => $("aboutDialog").showModal(),
    logout: signOut
};

document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
        profileMenu.open = false;
        menuActions[button.dataset.action]();
    });
});

document.querySelectorAll("[data-close]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog").close());
});

document.addEventListener("click", (event) => {
    if (!profileMenu.contains(event.target)) profileMenu.open = false;
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function initialize() {
    try {
        const { user } = await api("auth/me");
        if (user) await setSignedIn(user);
        else handleSignedOut();
    } catch (error) {
        handleSignedOut(error.message);
    }
}

initialize();
