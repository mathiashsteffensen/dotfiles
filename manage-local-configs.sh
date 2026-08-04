#!/bin/bash

# Script to help manage local configuration files for dotfiles
# This script provides helpful information about local config files and can create examples

set -e  # Exit on any error

echo "========================================"
echo "Local Configuration Management Script"
echo "========================================"

# Check if we're in the correct directory
if [ ! -f ".gitignore" ] || [ ! -f "install.sh" ]; then
    echo "Error: This script should be run from the dotfiles root directory."
    exit 1
fi

# List all local config files
echo "Local configuration files in this repository:"
echo "---------------------------------------------"
for file in ".bash_profile.local" ".bashrc.local" ".gitconfig.local"; do
    if [ -f "$file" ]; then
        echo "✓ $file (exists)"
    else
        echo "✗ $file (missing - example available)"
    fi
done

echo ""
echo "Example files (these can be copied to create local versions):"
echo "------------------------------------------------------------"
for file in ".bash_profile.local.example" ".bashrc.local.example" ".gitconfig.local.example"; do
    if [ -f "$file" ]; then
        echo "✓ $file (example exists)"
    else
        echo "✗ $file (missing)"
    fi
done

echo ""
echo "Local configuration file usage:"
echo "-------------------------------"
echo "These files are intentionally not tracked by Git and contain machine-specific settings."
echo ""
echo "Examples of what you might put in these files:"
echo ""
echo "For .bash_profile.local:"
echo "  # Add custom PATH entries"
echo "  export PATH=\"/opt/homebrew/bin:$PATH\""
echo ""
echo "For .bashrc.local:"
echo "  # Custom aliases or functions specific to this machine"
echo "  alias ll='ls -lah --color=auto'"
echo ""
echo "For .gitconfig.local:"
echo "  [user]"
echo "      name = Your Name"
echo "      email = you@example.com"
echo ""
echo "To create a local config file from an example:"
echo "  cp .bash_profile.local.example .bash_profile.local"
echo ""
echo "To set up your local configurations:"
echo "1. Copy any .example file to remove the .example extension"
echo "2. Customize the copied file with your machine-specific settings"
echo "3. The install script will automatically link these files if they exist"