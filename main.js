const connection = new signalR.HubConnectionBuilder()
    .withAutomaticReconnect()
    .withUrl("http://localhost:5701/bootstrapHub")
    .build();

const uploadMessages = document.getElementById("uploadMessages");
const fileList = document.getElementById("fileList");
const uploadAllButton = document.getElementById("uploadAllButton");
const overallProgressBar = document.getElementById("overallProgressBar");
const currentFileDiv = document.getElementById("currentFile");
const progressText = document.getElementById("progressText");
const sessionStatusContent = document.getElementById("sessionStatusContent");
const cancelAppIdInput = document.getElementById("cancelAppIdInput");
const cancelAppButton = document.getElementById("cancelAppButton");

let selectedFiles = [];
let ENCRYPTION_KEY = null;
let isUploading = false;
let currentSessionStatus = null;

// Encryption functions
async function importServerKey(key) {
    const keyBytes = Uint8Array.from(atob(key), c => c.charCodeAt(0));
    ENCRYPTION_KEY = await crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
    console.log("Encryption key imported successfully");
}

async function encryptChunk(buffer, encryptionKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encryptedData = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        encryptionKey,
        buffer
    );
    const result = new Uint8Array(iv.length + encryptedData.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(encryptedData), iv.length);
    return result;
}

// Utility functions
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function addMessage(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const color = type === 'error' ? '#f44336' : type === 'success' ? '#4caf50' : '#8bc34a';
    uploadMessages.innerHTML += `<p style="color: ${color};">[${timestamp}] ${message}</p>`;
    uploadMessages.scrollTop = uploadMessages.scrollHeight;
}

// NEW: Session status display functions
function updateSessionStatusDisplay(sessionData) {
    currentSessionStatus = sessionData;

    if (!sessionData || !sessionData.ItemList || sessionData.ItemList.length === 0) {
        sessionStatusContent.innerHTML = '<div class="no-session">No active session. Start an installation to see apps here.</div>';
        return;
    }

    const itemsHtml = sessionData.ItemList.map(item => {
        const status = item.Status.toLowerCase();
        const canCancel = status === 'pending';
        const progress = item.InstallProgress || 0;

        return `
                    <div class="app-item ${status}">
                        <div class="app-info">
                            <div class="app-name">${item.Id} v${item.Version}</div>
                            <div class="app-details">
                                Progress: ${progress}% | Status: ${item.Status}
                            </div>
                        </div>
                        <div style="display: flex; align-items: center;">
                            <span class="app-status status-${status}">${item.Status}</span>
                            ${canCancel ? `<button class="cancel-button" onclick="cancelAppById('${item.Id}', '${item.Version}')">Cancel</button>` : ''}
                        </div>
                    </div>
                `;
    }).join('');

    sessionStatusContent.innerHTML = `
                <div style="margin-bottom: 15px; font-size: 14px; color: #bbb;">
                    Session: ${sessionData.SessionStatus} | 
                    Total: ${sessionData.TotalItems} | 
                    Completed: ${sessionData.CompletedItems} | 
                    Failed: ${sessionData.FailedItems} | 
                    Pending: ${sessionData.PendingItems}
                </div>
                ${itemsHtml}
            `;
}

// NEW: Cancel app functions
async function cancelAppById(appId, version) {
    try {
        addMessage(`🚫 Attempting to cancel app: ${appId}`, 'info');
        await connection.invoke("ModifyInstallationSession", "cancel", { id: appId, version: version },);
    } catch (error) {
        addMessage(`❌ Failed to cancel ${appId}: ${error.message}`, 'error');
    }
}

// File management functions
function updateFileList() {
    if (selectedFiles.length === 0) {
        fileList.innerHTML = '<p style="color: #888; font-style: italic;">No files selected</p>';
        uploadAllButton.disabled = true;
        return;
    }

    fileList.innerHTML = selectedFiles.map((file, index) => `
                <div class="file-item">
                    <div class="file-info">
                        <div class="file-name">${file.name}</div>
                        <div class="file-size">${formatFileSize(file.size)}</div>
                    </div>
                    <button class="file-remove" onclick="removeFile(${index})">Remove</button>
                </div>
            `).join('');

    uploadAllButton.disabled = isUploading;
}

function removeFile(index) {
    selectedFiles.splice(index, 1);
    updateFileList();
}

function clearAllFiles() {
    selectedFiles = [];
    updateFileList();
    resetProgress();
}

function resetProgress() {
    overallProgressBar.style.width = '0%';
    currentFileDiv.textContent = 'Ready to upload...';
    progressText.textContent = '0 / 0 files completed';
}

// Upload functions (existing code)
async function uploadSingleFile(file, fileIndex, totalFiles) {
    try {
        currentFileDiv.textContent = `Uploading: ${file.name}`;
        addMessage(`Starting upload: ${file.name}`);

        const arrayBuffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        const chunkSize = 100 * 1024;
        const totalChunks = Math.ceil(file.size / chunkSize);

        await connection.invoke("StartUpload", {
            fileName: file.name,
            fileSize: file.size,
            chunkSize: chunkSize,
            expectedChecksum: hashHex
        });

        for (let i = 0; i < totalChunks; i++) {
            const chunk = file.slice(i * chunkSize, (i + 1) * chunkSize);
            const buffer = await chunk.arrayBuffer();
            const encryptedChunk = await encryptChunk(buffer, ENCRYPTION_KEY);
            const base64Chunk = btoa(String.fromCharCode(...new Uint8Array(encryptedChunk)));
            await connection.invoke("UploadChunk", base64Chunk, i);

            const fileProgress = ((i + 1) / totalChunks);
            const overallProgress = ((fileIndex + fileProgress) / totalFiles) * 100;
            overallProgressBar.style.width = overallProgress.toFixed(1) + "%";
        }

        await connection.invoke("EndUpload");
        addMessage(`✅ Upload completed: ${file.name}`, 'success');

        const overallProgress = ((fileIndex + 1) / totalFiles) * 100;
        overallProgressBar.style.width = overallProgress.toFixed(1) + "%";
        progressText.textContent = `${fileIndex + 1} / ${totalFiles} files completed`;

    } catch (error) {
        addMessage(`❌ Upload failed: ${file.name} - ${error.message}`, 'error');
        throw error;
    }
}

async function uploadAllFiles() {
    if (selectedFiles.length === 0 || isUploading) return;

    isUploading = true;
    uploadAllButton.disabled = true;
    uploadAllButton.textContent = '⏳ Uploading...';

    try {
        addMessage(`🚀 Starting upload of ${selectedFiles.length} files`);

        for (let i = 0; i < selectedFiles.length; i++) {
            await uploadSingleFile(selectedFiles[i], i, selectedFiles.length);
        }

        addMessage(`🎉 All files uploaded successfully!`, 'success');
        currentFileDiv.textContent = 'All uploads completed!';

        setTimeout(() => {
            clearAllFiles();
        }, 2000);

    } catch (error) {
        addMessage(`💥 Upload process failed: ${error.message}`, 'error');
        currentFileDiv.textContent = 'Upload failed!';
    } finally {
        isUploading = false;
        uploadAllButton.disabled = false;
        uploadAllButton.textContent = '📤 Upload All Files';
    }
}

// Event listeners
document.getElementById("bundleInput").addEventListener("change", (e) => {
    const files = Array.from(e.target.files);
    const bundleFiles = files.filter(file => file.name.endsWith(".bundle"));

    if (bundleFiles.length !== files.length) {
        addMessage(`⚠️ Only .bundle files are allowed. ${files.length - bundleFiles.length} files ignored.`, 'error');
    }

    bundleFiles.forEach(file => {
        if (!selectedFiles.some(f => f.name === file.name && f.size === file.size)) {
            selectedFiles.push(file);
        }
    });

    updateFileList();
    e.target.value = '';
});

uploadAllButton.addEventListener("click", uploadAllFiles);
// Test buttons
document.getElementById("testInstallButton").addEventListener("click", () => {
    const applications = [
        { id: "blender", version: "4.5.0" },
        { id: "r", version: "4.5.1" },
        { id: "pandas", version: "2.3.1" },
        { id: "pycharm", version: "2025.1.3.1" },
        { id: "github_desktop", version: "3.5.2" },
    ];
    connection.invoke("Install", applications).catch(err => {
        addMessage(`Install error: ${err}`, 'error');
    });
});

document.getElementById("stopInstallButton").addEventListener("click", () => {
    connection.invoke("ControlInstall", "stop").catch(err => {
        addMessage(`Stop error: ${err}`, 'error');
    });
});

document.getElementById("continueInstallButton").addEventListener("click", () => {
    connection.invoke("ControlInstall", "continue").catch(err => {
        addMessage(`Continue error: ${err}`, 'error');
    });
});

document.getElementById("getStatusButton").addEventListener("click", () => {
    connection.invoke("GetSessionStatus").catch(err => {
        addMessage(`Get Status error: ${err}`, 'error');
    });
});

// SignalR connection and event handlers
connection.start().then(() => {
    uploadMessages.innerHTML = '';
    addMessage("🟢 Connected to server", 'success');
}).catch(err => {
    addMessage("🔴 Failed to connect to server", 'error');
});

connection.on("BootstrapToWeb", function (message) {
    console.log("Server message:", message);
    addMessage(`🤖 ${message}`);
});

connection.on("SetEncryptionKey", (key) => {
    addMessage("🔐 Encryption key received");
    importServerKey(key);
});

connection.on("InstallCompleted", (msg) => {
    console.log("Install progress:", msg);
    // Auto-refresh status when install progress updates
    setTimeout(() => {
        connection.invoke("GetSessionStatus").catch(err => {
            console.error("Failed to refresh status:", err);
        });
    }, 500);
});

// NEW: Handle session status updates
connection.on("ReportSessionStatus", (statusJson) => {
    try {
        const status = typeof statusJson === 'string' ? JSON.parse(statusJson) : statusJson;
        // console.log("Session status received:", status);
        updateSessionStatusDisplay(status);
    } catch (error) {
        console.error("Failed to parse session status:", error);
        addMessage("⚠️ Failed to parse session status", 'error');
    }
});

connection.onreconnected(() => {
    addMessage("🔄 Reconnected to server", 'success');
});

connection.onclose(() => {
    addMessage("🔴 Disconnected from server", 'error');
});

connection.on("ReportInstallationRemainingTime", (data) => {
    console.log("[ReportInstallationRemainingTime]", data);
});