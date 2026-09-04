# Colors
RED='\033[0;31m'
NO_COLOR='\033[0m'

error() {
	echo -e "${RED}ERROR:${NO_COLOR} $1"
}

print() {
	echo "$@"
	echo ""
}

# Make new directory and change to it
new_dir() {
	mkdir -p "$1" && cd "$1"
}

# Function to kill a process running on a particular port
kill_port() {
	local port="${1:-}"
	[[ -n "$port" ]] || return 2
	local pids
	pids="$(lsof -t -i:"$port" 2>/dev/null)" || return 0
	[[ -n "$pids" ]] && kill -9 $pids
}

# Kill processes by name regex
kill_grep() {
	local pattern="${1:-}"
	[[ -n "$pattern" ]] || return 2
	local pids
	pids="$(pgrep "$pattern" 2>/dev/null)" || return 0
	[[ -n "$pids" ]] && kill -9 $pids
}

# Execute a command in each immediate subdirectory
each-dir() {
	local dir_name="$1"
	shift
	for directory in "./$dir_name"/*/; do
	  [[ -d "$directory" ]] || continue
	  print "In $directory"
	  ( cd "$directory" && echo-exec "$@" )
	done
}

# Execute a command for each file matching the pattern
each-file() {
	local pattern="$1"
	shift
	for file in ./$pattern; do
	  [[ -f "$file" ]] || continue
	  print "In $file"
	  ( echo-exec "$@" "$file" )
	done
}

# INTERNAL: Build a command string for concurrently that sources bash_profile.
bashify() {
	printf '/bin/bash -lc %q' "source ~/.bash_profile && $1"
}

# Run two commands concurrently
concurrently() {
	local command_1
	local command_2
	command_1="$(bashify "$1")"
	command_2="$(bashify "$2")"
	print-exec npx concurrently "$command_1" "$command_2"
}

print-exec() {
	print "$@"
	"$@"
}

echo-exec() {
	echo "$@"
	"$@"
}

# Start a disposable linux Docker container with pwd volume mount
linux() {
	local docker_args=${4:-""}
	local container_name=${3:-"linuxdev"}
	local base_image=${2:-"ubuntu:latest"}
	local start_cmd=${1:-"bash"}
	print "Starting Docker container - image='$base_image' cmd='$start_cmd' name='$container_name'"
	docker stop "$container_name" >/dev/null 2>&1 || true
	docker rm "$container_name" >/dev/null 2>&1 || true
	docker run -it --name="$container_name" $docker_args -v="$(pwd)":/app --net=host "$base_image" /bin/bash -c "apt-get update -y && cd app && $start_cmd"
}

# Start a linux Docker container with rbenv & Ruby installed
linux-rb() {
	linux "${1:-bash}" "ruby:3.2.4" "linuxdev-rb"
}

# Start a Docker container with the Docker socket mounted
linux-docker() {
	linux "apt-get install curl -y && curl -fsSL https://get.docker.com | sh && ${1:-bash}" "ubuntu:latest" "linuxdev-docker" "-v /var/run/docker.sock:/var/run/docker.sock"
}

# Start a Postgres Docker container
linux-pg() {
	linux "${1:-bash}" "postgres:14.2" "linuxdev-pg"
}

# Use a specific Ruby version for this bash session
ruby-use() {
	export RBENV_VERSION=$1
}

# Shut down simulators (iOS and Android)
kill-simulators() {
	# iOS
	xcrun simctl shutdown all
	# Android
	for ((PORT=5550; PORT<=5584; PORT+=2)); do
	    adb -s emulator-$PORT emu kill &> /dev/null
	done
}

# Deep clean docker system resources
docker-clean() {
	docker system prune --all --force --volumes
}

# Clean macOS DNS cache
dns-cache-clean() {
	sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder
}

# Watch a directory and run a command on changes
watch-dir() {
	fswatch -xrt . | xargs -n1 -I{} "$@"
}

watch-http-status() {
    uri="$1"

    while true;
    do
        status=$(curl -sS -L -o /dev/null -w '%{http_code}' "$uri")
        printf '%s %s\n' "$uri" "$status"
        sleep 2
    done
}

commit() {
    command -v gum >/dev/null 2>&1 || go install charm.land/gum/v2@latest

    if [ -z "$(git status -s -uno | grep -v '^ ' | awk '{print $2}')" ]; then
        gum confirm "Stage all?" && git add .
    fi

    TYPE=$(gum choose "fix" "feat" "docs" "style" "refactor" "test" "chore" "revert")
    SCOPE=$(gum input --placeholder "scope")

    # Since the scope is optional, wrap it in parentheses if it has a value.
    test -n "$SCOPE" && SCOPE="($SCOPE)"

    # Pre-populate the input with the type(scope): so that the user may change it
    SUMMARY=$(gum input --value "$TYPE$SCOPE: " --placeholder "Summary of this change")
    DESCRIPTION=$(gum write --placeholder "Details of this change")

    # Commit these changes if user confirms
    gum confirm "Commit changes?" && git commit -m "$SUMMARY" -m "$DESCRIPTION"
}
