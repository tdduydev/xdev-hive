// Package version giữ phiên bản worker, gán lúc build bằng -ldflags "-X .../version.Version=x.y.z".
package version

// Version là phiên bản worker gửi lên hub trong gói hello.
var Version = "0.0.0-dev"
