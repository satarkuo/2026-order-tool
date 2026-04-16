/**
 * 公司內部點餐工具 Core Logic
 *
 * 功能：
 * 1. Google Identity Services 登入
 * 2. Google Sheets API 讀取與寫入
 * 3. 權限控管 (Admin/Staff)
 * 4. 點餐與訂單管理
 */

// --- 設定 ---
const CONFIG = {
  // 請填入您的 GCP Client ID
  CLIENT_ID:
    "1047260174209-tkb7m5aj92rjhsck9jbnj5nf6idhkbra.apps.googleusercontent.com",
  // 請填入您的 Google Sheet ID
  SPREADSHEET_ID: "1Ku_7PWIrXiw_PHmo3GLZ-PeYCQ6v--0Xf5RoFLg3lJk",

  // Google Sheets Discovery Doc
  DISCOVERY_DOC: "https://sheets.googleapis.com/$discovery/rest?version=v4",
  // 授權範圍 (讀寫試算表 + 使用者資訊)
  SCOPES:
    "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile openid",
};

// --- 全域變數 ---
let tokenClient;
let gapiInited = false;
let gisInited = false;
let currentUser = null; // { email, name, role }

// Sheet 名稱對照
const SHEETS = {
  TODAY: "TodayConfig",
  MENU: "Menu",
  USERS: "Users",
  ORDERS: "Orders",
};

/**
 * 程式進入點
 */
document.addEventListener("DOMContentLoaded", () => {
  // 綁定按鈕事件
  const btnSignOut = document.getElementById("sign-out-btn");
  if (btnSignOut) btnSignOut.addEventListener("click", handleSignOut);

  // Admin 按鈕
  const btnOpenConfig = document.getElementById("btn-open-config");
  if (btnOpenConfig) btnOpenConfig.addEventListener("click", showConfigPanel);

  const btnSaveConfig = document.getElementById("btn-save-config");
  if (btnSaveConfig) btnSaveConfig.addEventListener("click", saveTodayConfig);

  const btnClearOrders = document.getElementById("btn-clear-orders");
  if (btnClearOrders) btnClearOrders.addEventListener("click", clearOrders);

  const btnCopyOrders = document.getElementById("btn-copy-orders");
  if (btnCopyOrders)
    btnCopyOrders.addEventListener("click", copyOrdersToClipboard);

  const btnSyncMenu = document.getElementById("btn-sync-menu");
  if (btnSyncMenu) btnSyncMenu.addEventListener("click", syncMenuToSheet);

  // Sidebar 導航綁定
  const sidebar = document.getElementById("sidebar");
  const sidebarOverlay = document.getElementById("sidebar-overlay");
  const hamburgerBtn = document.getElementById("hamburger-btn");

  // 手機版：開關側邊欄
  const toggleSidebar = () => {
    if (sidebar) sidebar.classList.toggle("open");
    if (sidebarOverlay) sidebarOverlay.classList.toggle("open");
  };

  if (hamburgerBtn) hamburgerBtn.addEventListener("click", toggleSidebar);
  if (sidebarOverlay) sidebarOverlay.addEventListener("click", toggleSidebar);

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const targetView = e.currentTarget.getAttribute("data-target");

      // 切換選單的 active 視覺狀態
      document
        .querySelectorAll(".nav-btn")
        .forEach((b) => b.classList.remove("active"));
      e.currentTarget.classList.add("active");

      switchView(targetView);

      // 手機板點擊後自動收合選單
      if (window.innerWidth <= 991) {
        if (sidebar && sidebar.classList.contains("open")) {
          toggleSidebar();
        }
      }
    });
  });

  // 登入按鈕綁定
  const loginBtn = document.getElementById("custom-login-btn");
  if (loginBtn) {
    loginBtn.addEventListener("click", handleLoginClick);
  }

  // 先初始化 GAPI，完成後再嘗試自動登入
  initGapiClient()
    .then(() => {
      console.log("GAPI ready, trying auto login...");
      tryAutoLogin();
    })
    .catch((err) => {
      console.error("GAPI init failed:", err);
      showLogin();
    });
});

// --- Google API 初始化 ---

/**
 * 處理登入按鈕點擊
 */
async function handleLoginClick() {
  try {
    showLoading("正在連線...");
    // 確保 GAPI 已載入
    await initGapiClient();
    // 強制彈出授權視窗 (取得新 Token)
    const token = await requestAccessToken(true);
    // 取得 Token 後進行後續載入
    await handleAuthFlow(token);
  } catch (err) {
    console.error("Login failed:", err);
    alert("登入失敗，請重試。");
    showLogin();
    hideLoading();
  }
}

/**
 * 嘗試自動登入 (用 LocalStorage 裡的 cached token)
 */
async function tryAutoLogin() {
  const savedToken = loadTokenFromStorage();
  if (!savedToken) {
    showLogin();
    return;
  }

  console.log("Found cached token, auto logging in...");
  // 設定 token 到 gapi client (此時 gapi 已初始化)
  gapi.client.setToken({ access_token: savedToken });

  try {
    await handleAuthFlow(savedToken);
  } catch (err) {
    console.warn("Auto login failed, clearing cached token:", err);
    // 自動登入失敗 → 清除舊 token，顯示登入按鈕
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXP_KEY);
    gapi.client.setToken("");
    showLogin();
    hideLoading();
  }
}

/**
 * 主要授權與載入資料流程
 * @param {string} accessToken
 */
async function handleAuthFlow(accessToken) {
  showLoading("正在驗證身分並載入權限...");
  hideLogin();

  // 確保 gapi client 有正確的 token
  gapi.client.setToken({ access_token: accessToken });

  // 1. 取得使用者 Profile
  const profile = await fetchUserProfile(accessToken);
  if (!profile || !profile.email) {
    // Token 無效或 scope 不足，清除並要求重登
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXP_KEY);
    gapi.client.setToken("");
    throw new Error("無法取得使用者資訊，Token 可能已過期或權限不足。");
  }

  const email = profile.email;
  const name = profile.name || email.split("@")[0];
  console.log("User:", email, name);

  // 2. 讀取 Users 表確認身分
  const userRole = await checkUserPermission(email);

  if (!userRole) {
    alert("抱歉，您不在授權名單中。請聯繫管理員。");
    handleSignOut();
    return;
  }

  currentUser = { email, name, role: userRole };
  updateUIForUser();

  // 3. 載入資料
  await loadAppArgs();

  // 4. 重啟進入預設視圖 (今日菜單)
  switchView("view-menu");
}

/**
 * 使用 Access Token 取得 User Profile
 */
async function fetchUserProfile(accessToken) {
  try {
    const response = await fetch(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    if (!response.ok) throw new Error("Failed to fetch user profile");
    return await response.json();
  } catch (err) {
    console.error(err);
    return null;
  }
}

/**
 * 初始化 GAPI Client
 */
function initGapiClient() {
  return new Promise((resolve, reject) => {
    if (gapiInited) {
      resolve();
      return;
    }
    gapi.load("client", async () => {
      try {
        await gapi.client.init({
          discoveryDocs: [CONFIG.DISCOVERY_DOC],
        });
        gapiInited = true;
        resolve();
      } catch (err) {
        console.error("Error initializing GAPI client", err);
        reject(err);
      }
    });
  });
}

/**
 * 請求 Access Token
 * @param {boolean} forcePrompt 是否強制顯示彈窗
 */
function requestAccessToken(forcePrompt = false) {
  return new Promise((resolve, reject) => {
    // [新增] 檢查 LocalStorage 是否有有效的 Token (僅在非強制模式下)
    if (!forcePrompt) {
      const savedToken = loadTokenFromStorage();
      if (savedToken) {
        console.log("Using valid cached token.");
        // 設定 gapi client token
        gapi.client.setToken({ access_token: savedToken });
        resolve(savedToken);
        return;
      }
    }

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope: CONFIG.SCOPES,
      callback: (tokenResponse) => {
        if (tokenResponse && tokenResponse.access_token) {
          // [新增] 儲存 Token
          saveTokenToStorage(tokenResponse);
          resolve(tokenResponse.access_token);
        } else {
          reject("Failed to get access token");
        }
      },
      error_callback: (err) => {
        reject(err);
      },
    });

    if (forcePrompt) {
      // 強制顯示彈窗
      tokenClient.requestAccessToken({ prompt: "consent" });
    } else {
      // 嘗試靜默或預設
      tokenClient.requestAccessToken({ prompt: "" });
    }
  });
}

// --- Token Persistence Helpers ---
const TOKEN_KEY = "google_access_token";
const TOKEN_EXP_KEY = "google_token_expires_at";

function saveTokenToStorage(tokenResponse) {
  const expiresIn = tokenResponse.expires_in || 3599; // 預設 1小時
  const now = Date.now();
  // 提早 5 分鐘過期，避免邊界狀況
  const expiresAt = now + expiresIn * 1000 - 5 * 60 * 1000;

  localStorage.setItem(TOKEN_KEY, tokenResponse.access_token);
  localStorage.setItem(TOKEN_EXP_KEY, expiresAt);
}

function loadTokenFromStorage() {
  const token = localStorage.getItem(TOKEN_KEY);
  const expiresAt = localStorage.getItem(TOKEN_EXP_KEY);

  if (!token || !expiresAt) return null;

  if (Date.now() < parseInt(expiresAt)) {
    return token;
  } else {
    console.log("Cached token expired.");
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXP_KEY);
    return null;
  }
}

function handleSignOut() {
  const token = gapi.client.getToken();
  if (token !== null) {
    google.accounts.oauth2.revoke(token.access_token);
    gapi.client.setToken("");
  }
  // [新增] 清除 LocalStorage
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXP_KEY);

  currentUser = null;
  document.getElementById("user-name").textContent = "";

  // 回到登入頁
  showLogin();
}

// --- 業務邏輯 ---

/**
 * 檢查使用者權限
 * 回傳 role ('管理員', '一般成員') 或 null
 */
async function checkUserPermission(email) {
  try {
    const response = await gapi.client.sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: `${SHEETS.USERS}!A:C`, // 假設 A:姓名, B:Email, C:權限
    });

    const rows = response.result.values;
    if (!rows || rows.length === 0) return null;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const userEmail = row[1]; // B欄
      if (userEmail === email) {
        return row[2]; // C欄：權限
      }
    }
    return null;
  } catch (err) {
    console.error("Error checking permission:", err);
    return null;
  }
}

async function loadAppArgs() {
  showLoading("載入菜單中...");
  try {
    // 1. 取得今日餐廳設定
    const todayConfig = await getTodayRestaurants();
    document.getElementById("today-restaurants").textContent =
      todayConfig.length > 0 ? `(${todayConfig.join(", ")})` : "(尚未設定)";

    // 2. 取得所有菜單 並 過濾
    const allMenu = await getAllMenu();

    // 3. 渲染介面
    renderMenu(todayConfig, allMenu);

    hideLoading();
  } catch (err) {
    console.error("Error loading app data:", err);
    alert("載入資料失敗，請檢查網路或 API 設定。");
    hideLoading();
  }
}

// 取得今日餐廳 (TodayConfig Sheet)
async function getTodayRestaurants() {
  try {
    const response = await gapi.client.sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: `${SHEETS.TODAY}!A:A`,
    });
    const rows = response.result.values;
    if (!rows || rows.length <= 1) {
      // 如果未設定，預設全開
      const allMenu = await getAllMenu();
      return [...new Set(allMenu.map((item) => item.restaurant))];
    }
    return rows
      .slice(1)
      .map((row) => row[0])
      .filter((val) => val);
  } catch (err) {
    console.warn("無法取得今日設定，預設為全開");
    const allMenu = await getAllMenu();
    return [...new Set(allMenu.map((item) => item.restaurant))];
  }
}

// 取得完整菜單 (替換為全新健康主題 Dataset，使用確保無破圖的 Unsplash 網址)
async function getAllMenu() {
  return [
    // 能量波奇碗
    {
      restaurant: "能量波奇碗",
      name: "鮮蔬鮭魚波奇碗 (Poke)",
      price: "180",
      category: "健康碗",
      img: "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?q=80&w=600&auto=format&fit=crop",
      hint: "例：不加生洋蔥、飯少",
    },
    {
      restaurant: "能量波奇碗",
      name: "低卡舒肥雞胸溫沙拉",
      price: "140",
      category: "健康沙拉",
      img: "https://images.unsplash.com/photo-1512621776951-a57141f2eefd?q=80&w=600&auto=format&fit=crop",
      hint: "例：醬料另外裝、去小黃瓜",
    },
    {
      restaurant: "能量波奇碗",
      name: "藜麥毛豆鮮蝦沙拉",
      price: "160",
      category: "健康沙拉",
      img: "https://images.unsplash.com/photo-1515543237350-b3eea1ec8082?q=80&w=600&auto=format&fit=crop",
      hint: "例：蝦不要去尾、醬全加",
    },

    // 纖維輕食餐盒
    {
      restaurant: "纖維輕食餐盒",
      name: "糙米鯖魚高纖便當",
      price: "135",
      category: "健康便當",
      img: "https://images.unsplash.com/photo-1547496502-affa22d38842?q=80&w=600&auto=format&fit=crop",
      hint: "例：飯減半",
    },
    {
      restaurant: "纖維輕食餐盒",
      name: "蔥鹽水煮牛低脂便當",
      price: "150",
      category: "健康便當",
      img: "https://images.unsplash.com/photo-1490645935967-10de6ba17061?q=80&w=600&auto=format&fit=crop",
      hint: "例：不要加蔥薑蒜",
    },
    {
      restaurant: "纖維輕食餐盒",
      name: "烤時蔬地瓜原型餐",
      price: "125",
      category: "原型食物",
      img: "https://images.unsplash.com/photo-1540420773420-3366772f4999?q=80&w=600&auto=format&fit=crop",
      hint: "例：番薯要軟一點",
    },

    // 零負擔飲品舖
    {
      restaurant: "零負擔飲品舖",
      name: "極上無糖烏龍綠",
      price: "40",
      category: "無糖飲料",
      img: "https://images.unsplash.com/photo-1556881286-fc6915169721?q=80&w=600&auto=format&fit=crop",
      hint: "例：微冰、完全去冰",
    },
    {
      restaurant: "零負擔飲品舖",
      name: "玫瑰奇亞籽氣泡水",
      price: "60",
      category: "無糖飲料",
      img: "https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?q=80&w=600&auto=format&fit=crop",
      hint: "例：不要紙吸管、少冰",
    },
    {
      restaurant: "零負擔飲品舖",
      name: "100% 綜合綠粒果汁",
      price: "85",
      category: "健康飲",
      img: "https://images.unsplash.com/photo-1600271886742-f049cd451bba?q=80&w=600&auto=format&fit=crop",
      hint: "例：完全去冰、不要濾渣",
    },

    // 生銅減醣甜點
    {
      restaurant: "生銅減醣甜點",
      name: "減醣豆腐布朗尼",
      price: "70",
      category: "減醣甜點",
      img: "https://images.unsplash.com/photo-1606890737304-57a1ca8a5b62?q=80&w=600&auto=format&fit=crop",
      hint: "例：不用附塑膠刀叉",
    },
    {
      restaurant: "生銅減醣甜點",
      name: "無加糖莓果燕麥優格",
      price: "65",
      category: "減醣甜點",
      img: "https://images.unsplash.com/photo-1488477181946-6428a0291777?q=80&w=600&auto=format&fit=crop",
      hint: "例：燕麥跟優格分開裝",
    },
  ];
}

// 用於管理分類過濾
let currentMenuFilter = "all";

async function setMenuFilter(filterType) {
  currentMenuFilter = filterType;
  const allMenu = await getAllMenu();
  const todayConfig = await getTodayRestaurants();
  renderMenu(todayConfig, allMenu);
}

// 渲染菜單
function renderMenu(todayRestaurants, allMenu) {
  const container = document.getElementById("menu-container");
  const tabsContainer = document.getElementById("category-tabs");

  if (tabsContainer) {
    let tabsHTML = `<button class="tab-btn ${currentMenuFilter === "all" ? "active" : ""}" onclick="setMenuFilter('all')">🌟 全部主題</button>`;
    todayRestaurants.forEach((r) => {
      const isActive = currentMenuFilter === r ? "active" : "";
      tabsHTML += `<button class="tab-btn ${isActive}" onclick="setMenuFilter('${r}')">${r}</button>`;
    });
    tabsContainer.innerHTML = tabsHTML;
  }

  container.innerHTML = "";

  if (todayRestaurants.length === 0) {
    container.innerHTML = "<p>今日尚未設定餐廳，請稍候或聯繫管理員。</p>";
    return;
  }

  // 依據選擇的 Tab 與今日設定過濾菜單
  const todayMenu = allMenu.filter((item) => {
    if (currentMenuFilter !== "all" && item.restaurant !== currentMenuFilter)
      return false;
    return todayRestaurants.includes(item.restaurant);
  });

  if (todayMenu.length === 0) {
    container.innerHTML = "<p>找不到今日餐廳的菜單資料。</p>";
    return;
  }

  todayMenu.forEach((item) => {
    // 若該菜色有專屬圖片則使用，否則使用預設健康圖片
    const defaultImg =
      "https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=600&q=80";
    const bgImage = item.img || defaultImg;
    const placeholderHint = item.hint || "例：少冰、不加蔥花";

    const card = document.createElement("div");
    card.className = "card card-meal menu-item";
    card.innerHTML = `
            <img src="${bgImage}" class="card-img" alt="${item.name}">
            <div class="card-content">
                <h4>${item.restaurant} - ${item.name}</h4>
                <div class="category text-secondary">${item.category}</div>
                <div class="action-area">
                    <div class="price-tag">$${item.price}</div>
                    <input type="text" class="note-input" placeholder="備註 (${placeholderHint})">
                    <button class="btn btn-primary btn-order" onclick="submitOrder('${item.restaurant}', '${item.name}', '${item.price}', this)">點餐並送出</button>
                </div>
            </div>
        `;
    container.appendChild(card);
  });
}

// 送出訂單
async function submitOrder(restaurant, foodName, price, btnElement) {
  if (!currentUser) return;

  const card = btnElement.closest(".card-content");
  const note = card.querySelector(".note-input").value;
  const timestamp = new Date().toLocaleString("zh-TW", { hour12: false });

  // 禁用按鈕避免重複
  btnElement.disabled = true;
  btnElement.textContent = "處理中...";

  const orderData = [
    timestamp,
    currentUser.email,
    restaurant,
    foodName,
    price,
    note,
  ];

  try {
    await gapi.client.sheets.spreadsheets.values.append({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: `${SHEETS.ORDERS}!A:F`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [orderData] },
    });

    alert(`點餐成功：${foodName}`);
    card.querySelector(".note-input").value = ""; // 清空備註
  } catch (err) {
    console.error("Order failed", err);
    alert("點餐失敗，請重試。");
  } finally {
    btnElement.disabled = false;
    btnElement.textContent = "點餐";
  }
}

// --- 管理員功能 ---
async function showConfigPanel() {
  const panel = document.getElementById("admin-config-panel");
  const container = document.getElementById("restaurant-checkboxes");
  container.innerHTML = "讀取中...";
  panel.classList.remove("hidden");

  try {
    const allMenu = await getAllMenu();
    const restaurants = [...new Set(allMenu.map((item) => item.restaurant))];

    container.innerHTML = "";
    restaurants.forEach((r) => {
      const div = document.createElement("div");
      div.innerHTML = `
                <label>
                    <input type="checkbox" value="${r}" name="restaurant-select"> 
                    <span style="margin-left:8px;">${r}</span>
                </label>
            `;
      container.appendChild(div);
    });
  } catch (err) {
    container.textContent = "載入餐廳失敗";
  }
}

async function saveTodayConfig() {
  const checkboxes = document.querySelectorAll(
    'input[name="restaurant-select"]:checked',
  );
  const selected = Array.from(checkboxes).map((cb) => cb.value);

  if (selected.length === 0) {
    if (!confirm("確定不選擇任何餐廳嗎？(將清空今日設定)")) return;
  }

  try {
    // 先清空 TodayConfig Sheet
    await gapi.client.sheets.spreadsheets.values.clear({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: `${SHEETS.TODAY}!A2:A`, // 保留標題
    });

    if (selected.length > 0) {
      // 寫入新設定
      const values = selected.map((r) => [r]);
      await gapi.client.sheets.spreadsheets.values.append({
        spreadsheetId: CONFIG.SPREADSHEET_ID,
        range: `${SHEETS.TODAY}!A2`,
        valueInputOption: "USER_ENTERED",
        resource: { values: values },
      });
    }

    alert("設定已儲存！");
    document.getElementById("admin-config-panel").classList.add("hidden");
    // 重新載入介面資料
    loadAppArgs();
  } catch (err) {
    console.error(err);
    alert("儲存失敗");
  }
}

/**
 * 將 JS 內的菜單資料同步寫入 Google Sheet Menu 分頁
 * 流程：先清空 Menu!A2 以下，再寫入標題列（若不存在）與所有品項
 */
async function syncMenuToSheet() {
  if (
    !confirm(
      "確定要將 JS 菜單資料同步寫入 Google Sheet 的 Menu 分頁嗎？\n這會先清除該分頁的現有資料！",
    )
  )
    return;

  try {
    showLoading("同步菜單中...");

    const allMenu = await getAllMenu();

    // 1. 清空 Menu Sheet (保留第一列標題)
    await gapi.client.sheets.spreadsheets.values.clear({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: `${SHEETS.MENU}!A1:Z`,
    });

    // 2. 寫入標題列 + 所有菜單資料
    const header = ["restaurant", "name", "price", "category", "img", "hint"];
    const rows = allMenu.map((item) => [
      item.restaurant,
      item.name,
      item.price,
      item.category,
      item.img || "",
      item.hint || "",
    ]);

    await gapi.client.sheets.spreadsheets.values.update({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: `${SHEETS.MENU}!A1`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [header, ...rows] },
    });

    hideLoading();
    alert(`同步完成！共寫入 ${rows.length} 筆菜單資料到 Menu 分頁。`);
  } catch (err) {
    console.error("syncMenuToSheet failed:", err);
    hideLoading();
    alert("同步失敗，請確認 Google Sheet 中已有 Menu 分頁，或檢查權限設定。");
  }
}

async function clearOrders() {
  if (!confirm("⚠️ 警告：確定要清空今日所有訂單資料嗎？此動作無法復原！"))
    return;

  try {
    await gapi.client.sheets.spreadsheets.values.clear({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: `${SHEETS.ORDERS}!A2:F`, // 保留標題
    });
    alert("訂單已清空。");
    // 如果目前在訂單畫面，就重整
    const activeView = document.querySelector(".view-item.active-view");
    if (activeView && activeView.id === "view-orders") {
      loadOrdersView();
    }
  } catch (err) {
    console.error(err);
    alert("清空失敗");
  }
}

// --- 視圖管理與訂單檢視 ---

/**
 * 切換右側的主畫面內容
 * @param {string} viewId
 */
function switchView(viewId) {
  // 隱藏所有視圖
  document.querySelectorAll(".view-item").forEach((v) => {
    v.classList.remove("active-view");
    v.classList.add("hidden");
  });

  const target = document.getElementById(viewId);
  if (!target) return;

  target.classList.remove("hidden");

  // 延遲一點點發動 CSS 動畫
  setTimeout(() => {
    target.classList.add("active-view");
  }, 20);

  // Contextual Loading: 若切換到訂單頁，即時請求資料
  if (viewId === "view-orders") {
    loadOrdersView();
  }
}

async function loadOrdersView() {
  const tbody = document.getElementById("orders-list");
  const totalSpan = document.getElementById("total-amount");

  tbody.innerHTML =
    "<tr><td colspan='6' style='text-align:center;'>載入中...</td></tr>";
  const cardsContainer = document.getElementById("orders-cards");
  cardsContainer.innerHTML =
    "<p style='text-align:center;color:#888;'>載入中...</p>";

  try {
    const response = await gapi.client.sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.SPREADSHEET_ID,
      range: `${SHEETS.ORDERS}!A2:F`,
    });

    const rows = response.result.values || [];
    tbody.innerHTML = "";

    if (rows.length === 0) {
      tbody.innerHTML =
        "<tr><td colspan='6' style='text-align:center;'>今日尚無訂單</td></tr>";
      cardsContainer.innerHTML =
        "<p style='text-align:center;color:#888;'>今日尚無訂單</p>";
      totalSpan.textContent = 0;
      return;
    }

    cardsContainer.innerHTML = "";

    let total = 0;
    rows.forEach((row) => {
      const price = parseInt(row[4]) || 0;
      total += price;
      const note = row[5] ? row[5] : "";

      // table row
      const tr = document.createElement("tr");
      tr.innerHTML = `
          <td>${row[0] || "-"}</td>
          <td>${row[1] || "-"}</td>
          <td>${row[2] || "-"}</td>
          <td>${row[3] || "-"}</td>
          <td class="text-primary font-weight-bold">$${price}</td>
          <td>${note || "-"}</td>
      `;
      tbody.appendChild(tr);

      // mobile card
      const card = document.createElement("div");
      card.className = "order-card";
      card.innerHTML = `
        <span class="order-card-label">時間</span><span class="order-card-value">${row[0] || "-"}</span>
        <span class="order-card-label">訂購人</span><span class="order-card-value">${row[1] || "-"}</span>
        <span class="order-card-label">餐廳</span><span class="order-card-value">${row[2] || "-"}</span>
        <span class="order-card-label">餐點</span><span class="order-card-value">${row[3] || "-"}</span>
        <span class="order-card-label">金額</span><span class="order-card-value price">$${price}</span>
        ${note ? `<div class="order-card-note">📝 ${note}</div>` : ""}
      `;
      cardsContainer.appendChild(card);
    });

    totalSpan.textContent = total;
  } catch (err) {
    console.error("loadOrdersView failed:", err);
    tbody.innerHTML =
      "<tr><td colspan='6' style='text-align:center;color:red;'>載入訂單失敗，請重試</td></tr>";
    cardsContainer.innerHTML =
      "<p style='text-align:center;color:red;'>載入訂單失敗，請重試</p>";
    totalSpan.textContent = 0;
  }
}

function copyOrdersToClipboard() {
  // 將訂單轉為純文字格式
  const rows = document.querySelectorAll("#orders-list tr");
  let text = "📋 今日點餐清單：\n\n";

  rows.forEach((row) => {
    const cols = row.querySelectorAll("td");
    if (cols.length < 5) return; // Skip empty/loading
    // 時間, Email, 餐廳, 餐點, 金額, 備註
    const restaurant = cols[2].textContent;
    const food = cols[3].textContent;
    const price = cols[4].textContent;
    const email = cols[1].textContent;
    const note =
      cols[5].textContent && cols[5].textContent !== "-"
        ? `(${cols[5].textContent})`
        : "";

    text += `[${restaurant}] ${food} ${price} - ${email} ${note}\n`;
  });

  const total = document.getElementById("total-amount").textContent;
  text += `\n💰 總金額：${total} 元`;

  navigator.clipboard.writeText(text).then(
    () => {
      alert("已複製到剪貼簿！可以貼到 Line 了！");
    },
    () => {
      alert("複製失敗，請手動複製。");
    },
  );
}

// --- UI Helper ---

function showLoading(msg) {
  document.getElementById("status-section").classList.remove("hidden");
  document.getElementById("status-text").textContent = msg || "載入中...";
}

function hideLoading() {
  document.getElementById("status-section").classList.add("hidden");
}

function showLogin() {
  document.getElementById("login-section").classList.remove("hidden");
  document.getElementById("app-layout").classList.add("hidden");
}

function hideLogin() {
  document.getElementById("login-section").classList.add("hidden");
  document.getElementById("app-layout").classList.remove("hidden");
}

function updateUIForUser() {
  // 顯示使用者名稱
  document.getElementById("user-name").textContent =
    `${currentUser.name} (${currentUser.role})`;

  // 根據身份隱藏或顯示管理員按鈕
  const adminBtn = document.getElementById("nav-btn-admin");
  if (currentUser.role === "管理員") {
    adminBtn.classList.remove("hidden");
  } else {
    adminBtn.classList.add("hidden");
  }
}
