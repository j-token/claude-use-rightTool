prep:
	until curl -sf localhost:3000/health; do sleep 2; done

all: prep build

build:
	node -e "console.log(1)"

test:
	pytest -q
