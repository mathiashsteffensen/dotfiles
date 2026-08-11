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
	kill -9 $(lsof -t -i:$1)
}

# Kill processes by name regex
kill_grep() {
	kill -9 $(pgrep "$1")
}

# Execute a command in each immediate subdirectory
each-dir() {
	DIR_NAME=$1
	shift
	for directory in ./"$DIR_NAME"/*/ ; do
	  print "In $directory"
	  ( cd "$directory" && echo-exec "$@" )
	done
}

# Execute a command in each file matching the pattern
each-file() {
	DIR_NAME=$1
	shift
	for file in ./"$DIR_NAME" ; do
	  print "In $file"
	  ( echo-exec "$@" )
	done
}

# INTERNAL: Wrap command in a subshell sourcing bash_profile
bashify() {
	echo "/bin/bash -c 'source ~/.bash_profile && $*'"
}

# Run two commands concurrently
concurrently() {
	COMMAND_1=$(bashify "$1")
	COMMAND_2=$(bashify "$2")
	print-exec npx concurrently "\"$COMMAND_1\"" "\"$COMMAND_2\""
}

print-exec() {
	print "$@"
	/bin/bash -c "$@"
}

echo-exec() {
	echo "$@"
	/bin/bash -c "$@"
}

# Start a disposable linux Docker container with pwd volume mount
linux() {
	docker_args=${4:-""}
	container_name=${3:-"linuxdev"}
	base_image=${2:-"ubuntu:latest"}
	start_cmd=${1:-"bash"}
	print "Starting Docker container - image='$base_image' cmd='$start_cmd' name='$container_name'"
	echo-exec "docker stop $container_name"
	echo-exec "docker rm $container_name"
	echo-exec "docker run -it --name=$container_name $docker_args -v=$(pwd):/app --net=host $base_image /bin/bash -c 'apt-get update -y && cd app && $start_cmd'"
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
