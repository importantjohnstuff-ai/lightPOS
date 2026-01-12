#!/bin/bash

# Configuration
REMOTE_USER="john"
REMOTE_HOST="192.168.0.177"
TARGET_DIR="/opt/lampp/htdocs/lightPOS"

echo "Deploying to ${REMOTE_USER}@${REMOTE_HOST}:${TARGET_DIR}"

# SSH Multiplexing Config
SSH_SOCKET=~/.ssh/deploy_socket
mkdir -p ~/.ssh

echo "Establishing persistent connection..."
echo "You will be prompted for your SSH password once (if no keys) and then the Remote Sudo password."

# 1. Open Master SSH Connection
ssh -M -S $SSH_SOCKET -f -N -o ControlPersist=10m ${REMOTE_USER}@${REMOTE_HOST}

# 2. Capture Sudo Password locally
read -s -p "Enter Remote Sudo Password for ${REMOTE_USER}: " REMOTE_SUDO_PASS
echo ""

# Function to cleanup connection on exit
cleanup() {
    echo "Closing connection..."
    ssh -S $SSH_SOCKET -O exit ${REMOTE_USER}@${REMOTE_HOST} 2>/dev/null
}
trap cleanup EXIT

# 3. Stop XAMPP & Prepare Directory (piping sudo password)
echo "Stopping remote XAMPP and preparing directory..."
ssh -S $SSH_SOCKET -t ${REMOTE_USER}@${REMOTE_HOST} "echo '$REMOTE_SUDO_PASS' | sudo -S -k /opt/lampp/lampp stop; echo '$REMOTE_SUDO_PASS' | sudo -S -k mkdir -p ${TARGET_DIR}; echo '$REMOTE_SUDO_PASS' | sudo -S -k chown -R ${REMOTE_USER} ${TARGET_DIR}"

# 4. Sync Files
echo "Syncing project files..."
rsync -avz --delete \
    -e "ssh -S $SSH_SOCKET" \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'data/restore.lock' \
    --exclude 'data/database.sqlite' \
    ./ ${REMOTE_USER}@${REMOTE_HOST}:${TARGET_DIR}/

# 5. Finalize on Remote (piping sudo password)
echo "Running final setup on remote..."
ssh -S $SSH_SOCKET -t ${REMOTE_USER}@${REMOTE_HOST} "echo '$REMOTE_SUDO_PASS' | sudo -S -k bash ${TARGET_DIR}/remote_finish.sh '${TARGET_DIR}'"

echo "Deployment Done."
