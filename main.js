const connection = new signalR.HubConnectionBuilder()
    .withAutomaticReconnect()
    .withUrl("https://localhost:5701/bootstrapHub")
    .build();

const messages = document.getElementById("messages");
const uploadMessages = document.getElementById("uploadMessages");
const progressBar = document.getElementById("progressBar");

uploadMessages.innerHTML = `<p style="color: red"><b>Server is not running</b></p>`;

///////////////////////////////

let ENCRYPTION_KEY = null;

async function importServerKey(key) {
    const keyBytes = Uint8Array.from(atob(key), c => c.charCodeAt(0));
    console.log("ENCRYPTION_KEY Before: ", ENCRYPTION_KEY)
    ENCRYPTION_KEY = await crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
    console.log("ENCRYPTION_KEY After: ", ENCRYPTION_KEY)
}

async function encryptChunk(buffer, encryptionKey ) {
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

///////////////////////////////


connection.start().then(async () => {
    uploadMessages.innerHTML = `<p><b>Connected to server.</b></p>`;
    document.getElementById("zipInput").addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file || !file.name.endsWith(".bundle")) {
            alert("Please select a .bundle file.");
            return;
        }
        const arrayBuffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);

        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
        console.log("Checksum: ", hashHex)

        const chunkSize = 100 * 1024; //100 KB
        const totalChunks = Math.ceil(file.size / chunkSize);

        await connection.invoke("StartInstall", {
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

            const progress = ((i + 1) / totalChunks) * 100;
            progressBar.style.width = progress.toFixed(1) + "%";
        }

        await connection.invoke("EndUpload");
        uploadMessages.innerHTML += `<p>✅ Upload complete: ${file.name}</p>`;
    });

    document.getElementById("chatbox").addEventListener("keyup", function (event) {
        if (event.key === "Enter") {
            const message = event.target.value;
            if (message.trim() !== "") {
                connection.invoke("WebToBootstrap", message).catch(err => console.error("SignalR error:", err));
                displayUserMessage(message);
                event.target.value = "";
            }
        }
    });
});

connection.on("BootstrapToWeb", function (message) {
    console.log(JSON.parse(message))
    if (message.includes("Upload") || message.includes("Server ready")) {
        uploadMessages.innerHTML += `<p>${message}</p>`;
    } else {
        displayServerMessage(message);
    }
});

document.getElementById("readSystemInfo").onclick = function() {
    connection.invoke("GetWindowsSystemInfo").catch(function (err) {
        console.error("Error calling ReadSystemInfo:", err.toString());
    });
};
connection.on("ReadSystemInfo", function (systemInfo) {
    console.log("Reading system info...")
    console.log(systemInfo)
});

connection.on("SetEncryptionKey",  (key) => {
    console.log("Received Key:", key);
    importServerKey(key)
});

function displayUserMessage(text) {
    const div = document.createElement("div");
    div.className = "message user";
    div.innerHTML = `<div class="bubble">${text}</div><div class="icon">🧑</div>`;
    messages.prepend(div);
}

function displayServerMessage(text) {
    const div = document.createElement("div");
    div.className = "message server";
    div.innerHTML = `<div class="icon">🤖</div><div class="bubble">${text}</div>`;
    messages.prepend(div);
}