BINARY := pie
CMD := ./cmd/pie
PKG := ./...
GO ?= go

.PHONY: all build test lint vet fmt cover clean install

all: build

build:
	$(GO) build -trimpath -o bin/$(BINARY) $(CMD)

test:
	$(GO) test $(PKG)

cover:
	$(GO) test -coverprofile=coverage.out $(PKG)
	$(GO) tool cover -func=coverage.out | tail -n 1

vet:
	$(GO) vet $(PKG)

fmt:
	$(GO) fmt $(PKG)

lint: vet
	gofmt -l -s .

install:
	$(GO) install $(CMD)

clean:
	rm -rf bin dist coverage.out
