const groceryForm = document.getElementById("groceryForm");
const itemInput = document.getElementById("itemInput");
const groceryList = document.getElementById("groceryList");
const emptyMessage = document.getElementById("emptyMessage");
const listSelector = document.getElementById("listSelector");
const listTitle = document.getElementById("listTitle");
const itemCount = document.getElementById("itemCount");
const totalItemCount = document.getElementById("totalItemCount");
const crossedOffCountLabel = document.getElementById("crossedOffCount");
const profileMenu = document.querySelector(".profile-menu");
const GROCERY_ITEMS_API_URL = "http://192.168.2.69:3000/api/";

const lists = {
    weekly: [],
    pantry: []
};
let activeListId = listSelector.value;
const pendingRequestIds = new Set();
const itemsToAnimateIn = new Set();
const itemsToAnimateRemoved = new Set();
let removedItemExpirationTimer;

function saveLists() {
    try {
        localStorage.setItem("glist.groceryLists", JSON.stringify(lists));
    } catch (error) {
        console.error("Unable to save grocery lists in this browser:", error);
    }
}

function loadSavedLists() {
    try {
        const storedLists = JSON.parse(localStorage.getItem("glist.groceryLists"));

        if (!storedLists || typeof storedLists !== "object" || Array.isArray(storedLists)) {
            return false;
        }

        Object.keys(lists).forEach((listId) => {
            if (Array.isArray(storedLists[listId])) {
                lists[listId] = storedLists[listId]
                    .map((item) => typeof item === "string"
                        ? { id: null, name: item }
                        : item && {
                            id: typeof item.id === "string" ? item.id : null,
                            name: item.name,
                            created_at: item.created_at || null,
                            removed_at: item.removed_at || null
                        })
                    .filter((item) => item && typeof item.name === "string" && item.name.trim() !== "");
            }
        });

        return true;
    } catch (error) {
        console.error("Unable to load saved grocery lists:", error);
        return false;
    }
}

function renderCurrentList() {
    groceryList.replaceChildren();
    listTitle.textContent = listSelector.options[listSelector.selectedIndex].text;

    const currentItems = lists[activeListId];
    const crossedOffCount = currentItems.filter((item) => item.removed_at).length;
    totalItemCount.textContent = currentItems.length;
    crossedOffCountLabel.textContent = crossedOffCount;
    itemCount.setAttribute(
        "aria-label",
        `${currentItems.length} total ${currentItems.length === 1 ? "item" : "items"}, `
        + `${crossedOffCount} crossed off`
    );

    const sortedItems = [
        ...currentItems.filter((item) => !item.removed_at),
        ...currentItems.filter((item) => item.removed_at)
    ];

    sortedItems.forEach((item) => {
        const listItem = document.createElement("li");
        listItem.className = "grocery-item";
        listItem.dataset.itemId = item.id || "";
        if (itemsToAnimateIn.has(item)) {
            listItem.classList.add("is-entering");
            requestAnimationFrame(() => itemsToAnimateIn.delete(item));
        }
        if (itemsToAnimateRemoved.has(item)) {
            listItem.classList.add("is-crossing-off");
            requestAnimationFrame(() => itemsToAnimateRemoved.delete(item));
        }

        const itemDetails = document.createElement("div");
        itemDetails.className = "item-details";

        const itemText = document.createElement("span");
        itemText.className = "item-name";
        itemText.textContent = item.name;
        itemDetails.appendChild(itemText);
        if (item.created_at && Number.isFinite(Date.parse(item.created_at))) {
            const addedTime = document.createElement("time");
            addedTime.className = "item-added-time";
            addedTime.dateTime = item.created_at;
            addedTime.textContent = formatElapsedTime(item.created_at);
            addedTime.title = `Added ${new Date(item.created_at).toLocaleString()}`;
            itemDetails.appendChild(addedTime);
        }
        if (item.removed_at) {
            listItem.classList.add("is-removed");
            itemText.title = `Removed ${new Date(item.removed_at).toLocaleString()}`;
        }

        const removeButton = document.createElement("button");
        removeButton.className = "remove-btn";
        removeButton.textContent = item.removed_at ? "Removed" : "Remove";
        removeButton.disabled = item.pending === true || Boolean(item.removed_at);
        removeButton.addEventListener("click", async function () {
            removeButton.disabled = true;
            const requestId = crypto.randomUUID();
            if (item.id) pendingRequestIds.add(requestId);

            try {
                let removedItem;
                if (item.id) {
                    const response = await fetch(`${GROCERY_ITEMS_API_URL}items/${encodeURIComponent(item.id)}`, {
                        method: "DELETE",
                        headers: { "X-Client-Request-Id": requestId }
                    });

                    if (!response.ok) {
                        throw new Error(`Failed to delete grocery item: ${response.status}`);
                    }

                    const result = await response.json();
                    if (!result?.item || !result.item.removed_at) {
                        throw new Error("The grocery items API did not return the removal time.");
                    }
                    removedItem = result.item;
                } else {
                    removedItem = { ...item, removed_at: new Date().toISOString() };
                }

                markItemRemoved(removedItem, item);
            } catch (error) {
                console.error("Unable to delete grocery item:", error);
                removeButton.disabled = false;
            } finally {
                pendingRequestIds.delete(requestId);
            }
        });

        listItem.append(itemDetails, removeButton);
        groceryList.appendChild(listItem);
    });

    updateEmptyMessage();
    scheduleRemovedItemExpiration();
}

groceryForm.addEventListener("submit", async function (event) {
    event.preventDefault();

    const itemName = itemInput.value.trim();

    if (itemName === "") {
        return;
    }

    const listId = activeListId;
    const requestId = crypto.randomUUID();
    const item = {
        id: null,
        name: itemName,
        created_at: new Date().toISOString(),
        pending: true,
        requestId
    };
    pendingRequestIds.add(requestId);
    itemsToAnimateIn.add(item);
    lists[listId].push(item);

    saveLists();
    renderCurrentList();
    itemInput.value = "";
    itemInput.focus();

    try {
        const response = await fetch(`${GROCERY_ITEMS_API_URL}items`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Client-Request-Id": requestId
            },
            body: JSON.stringify({
                list_id: "550e8400-e29b-41d4-a716-446655440000",
                name: itemName,
                quantity: 1,
                unit: null,
                created_by: "7c9e6679-7425-40de-944b-e07fc1f90ae7"
            })
        });

        if (!response.ok) {
            throw new Error(`Failed to save grocery item: ${response.status}`);
        }

        const result = await response.json();
        if (!result?.item || typeof result.item.id !== "string") {
            throw new Error("The grocery items API did not return the saved item ID.");
        }

        upsertItem(result.item, requestId);
    } catch (error) {
        console.error("Unable to save grocery item:", error);

        const items = lists[listId];
        const itemIndex = items.indexOf(item);
        if (itemIndex !== -1) items.splice(itemIndex, 1);

        saveLists();
        renderCurrentList();
    } finally {
        pendingRequestIds.delete(requestId);
    }
});

listSelector.addEventListener("change", function () {
    activeListId = listSelector.value;
    renderCurrentList();
});



function updateEmptyMessage() {
    emptyMessage.style.display = groceryList.children.length === 0 ? "block" : "none";
}

function formatElapsedTime(timestamp) {
    const elapsedHours = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 3600000));

    if (elapsedHours < 1) return "Added less than an hour ago";
    if (elapsedHours < 24) {
        return `Added ${elapsedHours} ${elapsedHours === 1 ? "hour" : "hours"} ago`;
    }

    const elapsedDays = Math.floor(elapsedHours / 24);
    return `Added ${elapsedDays} ${elapsedDays === 1 ? "day" : "days"} ago`;
}

function refreshElapsedTimeLabels() {
    document.querySelectorAll(".item-added-time").forEach((label) => {
        label.textContent = formatElapsedTime(label.dateTime);
    });
}

setInterval(refreshElapsedTimeLabels, 60000);

function upsertItem(apiItem, requestId = null) {
    const existingEntry = Object.entries(lists)
        .flatMap(([listId, items]) => items
            .filter((item) => item.id === apiItem.id)
            .map((item) => ({ listId, item })))
        [0];
    const pendingEntry = requestId
        ? Object.entries(lists)
            .flatMap(([listId, items]) => items
                .filter((item) => item.requestId === requestId)
                .map((item) => ({ listId, item })))
            [0]
        : null;
    const item = existingEntry?.item || pendingEntry?.item || { id: apiItem.id, name: apiItem.name };
    if (!existingEntry && !pendingEntry) itemsToAnimateIn.add(item);

    item.id = apiItem.id;
    item.name = apiItem.name.trim();
    item.created_at = apiItem.created_at || item.created_at || null;
    item.removed_at = apiItem.removed_at || null;
    item.pending = false;
    delete item.requestId;

    if (existingEntry && pendingEntry && existingEntry.item !== pendingEntry.item) {
        lists[pendingEntry.listId].splice(
            lists[pendingEntry.listId].indexOf(pendingEntry.item),
            1
        );
    } else if (!existingEntry && !pendingEntry) {
        lists.weekly.push(item);
    }

    saveLists();
    renderCurrentList();
}

function markItemRemoved(apiItem, fallbackItem = null) {
    const matchingItem = fallbackItem || Object.values(lists)
        .flat()
        .find((item) => item.id === apiItem.id);

    if (matchingItem) {
        matchingItem.removed_at = apiItem.removed_at;
        itemsToAnimateRemoved.add(matchingItem);
        saveLists();
        renderCurrentList();
    }
}

function scheduleRemovedItemExpiration() {
    clearTimeout(removedItemExpirationTimer);
    const expiryTimes = Object.values(lists)
        .flat()
        .filter((item) => item.removed_at)
        .map((item) => Date.parse(item.removed_at) + 24 * 60 * 60 * 1000)
        .filter(Number.isFinite);

    if (expiryTimes.length === 0) return;

    const nextExpiry = Math.min(...expiryTimes);
    removedItemExpirationTimer = setTimeout(() => {
        refreshItemsFromApi().catch((error) => {
            console.error("Unable to refresh grocery items after removal retention expired:", error);
            const now = Date.now();
            Object.keys(lists).forEach((listId) => {
                lists[listId] = lists[listId].filter((item) =>
                    !item.removed_at || Date.parse(item.removed_at) + 24 * 60 * 60 * 1000 > now
                );
            });
            saveLists();
            renderCurrentList();
        });
    }, Math.max(0, nextExpiry - Date.now()));
}

async function refreshItemsFromApi() {
    const response = await fetch(`${GROCERY_ITEMS_API_URL}items`, { method: "GET" });

    if (!response.ok) {
        throw new Error(`Failed to load grocery items: ${response.status}`);
    }

    const result = await response.json();
    if (!result || !Array.isArray(result.items) || !result.items.every(
        (item) => item && typeof item.id === "string" && typeof item.name === "string"
    )) {
        throw new Error("The grocery items API must return an object containing named items with IDs.");
    }

    const pendingItems = lists.weekly.filter((item) => item.pending);
    lists.weekly = result.items
        .map((item) => ({
            id: item.id,
            name: item.name.trim(),
            created_at: item.created_at || null,
            removed_at: item.removed_at || null
        }))
        .filter((item) => item.name);
    lists.weekly.push(...pendingItems);
    saveLists();
    renderCurrentList();
}

const itemEvents = new EventSource(`${GROCERY_ITEMS_API_URL}items/events`);
itemEvents.addEventListener("open", () => {
    refreshItemsFromApi().catch((error) => {
        console.error("Unable to refresh grocery items after connecting to the event stream:", error);
    });
});
itemEvents.addEventListener("items-changed", (event) => {
    try {
        const change = JSON.parse(event.data);
        if (change.requestId && pendingRequestIds.has(change.requestId)) return;

        if (change.type === "created" && change.item
            && typeof change.item.id === "string" && typeof change.item.name === "string") {
            upsertItem(change.item, change.requestId);
        } else if (change.type === "removed" && change.item
            && typeof change.item.id === "string" && change.item.removed_at) {
            markItemRemoved(change.item);
        }
    } catch (error) {
        console.error("Unable to process grocery item update:", error);
    }
});

document.querySelectorAll("[data-dialog]").forEach((button) => {
    button.addEventListener("click", function () {
        profileMenu.open = false;
        document.getElementById(button.dataset.dialog).showModal();
    });
});

document.addEventListener("click", function (event) {
    if (!profileMenu.contains(event.target)) {
        profileMenu.open = false;
    }
});

async function initializeLists() {
    try {
        await refreshItemsFromApi();
    } catch (error) {
        if (!loadSavedLists()) {
            console.error("Unable to load grocery items:", error);
        }
        renderCurrentList();
    }
}

initializeLists();
