const groceryForm = document.getElementById("groceryForm");
const itemInput = document.getElementById("itemInput");
const groceryList = document.getElementById("groceryList");
const emptyMessage = document.getElementById("emptyMessage");
const listSelector = document.getElementById("listSelector");
const listTitle = document.getElementById("listTitle");
const profileMenu = document.querySelector(".profile-menu");
const GROCERY_ITEMS_API_URL = "http://localhost:3000/api/";

const lists = {
    weekly: [],
    pantry: []
};
let activeListId = listSelector.value;

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
                lists[listId] = storedLists[listId].filter(
                    (itemName) => typeof itemName === "string" && itemName.trim() !== ""
                );
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

    lists[activeListId].forEach((itemName, index) => {
        const listItem = document.createElement("li");
        listItem.className = "grocery-item";

        const itemText = document.createElement("span");
        itemText.className = "item-name";
        itemText.textContent = itemName;

        const removeButton = document.createElement("button");
        removeButton.className = "remove-btn";
        removeButton.textContent = "Remove";
        removeButton.addEventListener("click", function () {
            lists[activeListId].splice(index, 1);
            saveLists();
            renderCurrentList();
        });

        listItem.append(itemText, removeButton);
        groceryList.appendChild(listItem);
    });

    updateEmptyMessage();
}

groceryForm.addEventListener("submit", async function (event) {
    event.preventDefault();

    const itemName = itemInput.value.trim();

    if (itemName === "") {
        return;
    }

    const listId = activeListId;
    const itemIndex = lists[listId].push(itemName) - 1;

    saveLists();
    renderCurrentList();
    itemInput.value = "";
    itemInput.focus();

    try {
        const response = await fetch(`${GROCERY_ITEMS_API_URL}items`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
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
    } catch (error) {
        console.error("Unable to save grocery item:", error);

        const items = lists[listId];
        if (items[itemIndex] === itemName) {
            items.splice(itemIndex, 1);
        } else {
            const matchingIndex = items.lastIndexOf(itemName);
            if (matchingIndex !== -1) {
                items.splice(matchingIndex, 1);
            }
        }

        saveLists();
        renderCurrentList();
    }
});

listSelector.addEventListener("change", function () {
    activeListId = listSelector.value;
    renderCurrentList();
});



function updateEmptyMessage() {
    emptyMessage.style.display = groceryList.children.length === 0 ? "block" : "none";
}

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
        const response = await fetch(`${GROCERY_ITEMS_API_URL}items`, { method: "GET" });

        if (!response.ok) {
            throw new Error(`Failed to load grocery items: ${response.status}`);
        }

        const result = await response.json();
        if (!result || !Array.isArray(result.items) || !result.items.every(
            (item) => item && typeof item.name === "string"
        )) {
            throw new Error("The grocery items API must return an object containing an array of named items.");
        }

        lists.weekly = result.items.map((item) => item.name.trim()).filter(Boolean);
        saveLists();
    } catch (error) {
        if (!loadSavedLists()) {
            console.error("Unable to load grocery items:", error);
        }
    }

    renderCurrentList();
}

initializeLists();
