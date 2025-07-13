const connection = new signalR.HubConnectionBuilder()
    .withAutomaticReconnect()
    .withUrl("http://localhost:5701/bootstrapHub")
    .build();

const uploadMessages = document.getElementById("uploadMessages");
const fileList = document.getElementById("fileList");
const uploadAllButton = document.getElementById("uploadAllButton");
const clearFilesButton = document.getElementById("clearFilesButton");
const overallProgressBar = document.getElementById("overallProgressBar");
const currentFileDiv = document.getElementById("currentFile");
const progressText = document.getElementById("progressText");

let selectedFiles = [];
let ENCRYPTION_KEY = null;
let isUploading = false;

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

// File management
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

// Upload functions
async function uploadSingleFile(file, fileIndex, totalFiles) {
    try {
        currentFileDiv.textContent = `Uploading: ${file.name}`;
        addMessage(`Starting upload: ${file.name}`);

        // Calculate checksum
        const arrayBuffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        const chunkSize = 100 * 1024; // 100 KB
        const totalChunks = Math.ceil(file.size / chunkSize);

        // Start upload
        await connection.invoke("StartUpload", {
            fileName: file.name,
            fileSize: file.size,
            chunkSize: chunkSize,
            expectedChecksum: hashHex
        });

        // Upload chunks
        for (let i = 0; i < totalChunks; i++) {
            const chunk = file.slice(i * chunkSize, (i + 1) * chunkSize);
            const buffer = await chunk.arrayBuffer();
            const encryptedChunk = await encryptChunk(buffer, ENCRYPTION_KEY);

            const base64Chunk = btoa(String.fromCharCode(...new Uint8Array(encryptedChunk)));
            await connection.invoke("UploadChunk", base64Chunk, i);

            // Update progress
            const fileProgress = ((i + 1) / totalChunks);
            const overallProgress = ((fileIndex + fileProgress) / totalFiles) * 100;
            overallProgressBar.style.width = overallProgress.toFixed(1) + "%";
        }

        // End upload
        await connection.invoke("EndUpload");
        addMessage(`✅ Upload completed: ${file.name}`, 'success');

        // Update overall progress
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
            console.log(selectedFiles[i].name)
            await uploadSingleFile(selectedFiles[i], i, selectedFiles.length);
        }

        addMessage(`🎉 All files uploaded successfully!`, 'success');
        currentFileDiv.textContent = 'All uploads completed!';

        // Clear files after successful upload
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

    // Add new files to selection (avoid duplicates)
    bundleFiles.forEach(file => {
        if (!selectedFiles.some(f => f.name === file.name && f.size === file.size)) {
            selectedFiles.push(file);
        }
    });

    updateFileList();
    e.target.value = ''; // Reset input
});

uploadAllButton.addEventListener("click", uploadAllFiles);
clearFilesButton.addEventListener("click", clearAllFiles);

// Test buttons
document.getElementById("testInstallButton").addEventListener("click", () => {
    const applications = [
        // {
        //     id: "python_0.0.2",
        //     version: "3.11",
        // },
        // {
        //     id: "blender_0.0.1",
        //     version: "4.5.0",
        // },
        // {
        //     id: "python_0.0.2",
        //     version: "3.13",
        // },
        {
            id: "pycharm_community_0.0.1",
            version: "2025.1.3.1",
        }
    ]
    connection.invoke("Install", applications).catch(err => {
        addMessage(`Install error: ${err}`, 'error');
    });
});

document.getElementById("stopInstallButton").addEventListener("click", () => {
    connection.invoke("ControlInstall", "stop").catch(err => {
        addMessage(`Get Status error: ${err}`, 'error');
    });
});
document.getElementById("continueInstallButton").addEventListener("click", () => {
    connection.invoke("ControlInstall", "continue").catch(err => {
        addMessage(`Get Status error: ${err}`, 'error');
    });
});

document.getElementById("getStatusButton").addEventListener("click", () => {
    connection.invoke("GetSessionStatus").catch(err => {
        addMessage(`Get Status error: ${err}`, 'error');
    });
});

connection.on("ReportSessionStatus", (status) => {
    console.log(status)
})
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
    console.log(msg)
});

connection.onreconnected(() => {
    addMessage("🔄 Reconnected to server", 'success');
});

connection.onclose(() => {
    addMessage("🔴 Disconnected from server", 'error');
});