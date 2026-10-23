package secretstore

import (
	"context"
	"errors"
	"os"

	"github.com/godbus/dbus/v5"
	"github.com/zalando/go-keyring"
)

const secretService = "org.freedesktop.secrets"
const secretRoot = dbus.ObjectPath("/org/freedesktop/secrets")
const serviceIF = "org.freedesktop.Secret.Service"
const collectionIF = "org.freedesktop.Secret.Collection"
const itemIF = "org.freedesktop.Secret.Item"

type linuxKeyring struct{}
type dbusSecret struct {
	Session     dbus.ObjectPath
	Parameters  []byte
	Value       []byte
	ContentType string
}

func init() {
	platformBackend = func() backend { return linuxKeyring{} }
	classify = func(err error) *Error {
		var own *Error
		if errors.As(err, &own) {
			return &Error{Code: own.Code, Message: own.Message}
		}
		var e dbus.Error
		var ptr *dbus.Error
		if (errors.As(err, &e) && e.Name == "org.freedesktop.Secret.Error.IsLocked") || (errors.As(err, &ptr) && ptr.Name == "org.freedesktop.Secret.Error.IsLocked") {
			return locked()
		}
		if errors.Is(err, context.DeadlineExceeded) {
			return locked()
		}
		return unavailable()
	}
}

func (linuxKeyring) operate(s, u, value, op string) (string, error) {
	if os.Getenv("DBUS_SESSION_BUS_ADDRESS") == "" && os.Getenv("XDG_RUNTIME_DIR") == "" {
		return "", unavailable()
	}
	ctx, cancel := context.WithTimeout(context.Background(), readTimeout)
	defer cancel()
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return "", err
	}
	defer conn.Close()
	root := conn.Object(secretService, secretRoot)
	var collection dbus.ObjectPath
	if err := root.CallWithContext(ctx, serviceIF+".ReadAlias", 0, "default").Store(&collection); err != nil {
		return "", err
	}
	if collection == "/" {
		return "", unavailable()
	}
	var status dbus.Variant
	if err := conn.Object(secretService, collection).CallWithContext(ctx, "org.freedesktop.DBus.Properties.Get", 0, collectionIF, "Locked").Store(&status); err != nil {
		return "", err
	}
	if isLocked, ok := status.Value().(bool); !ok || isLocked {
		return "", locked()
	}
	var unlocked, lockedItems []dbus.ObjectPath
	attrs := map[string]string{"service": s, "username": u}
	if err := root.CallWithContext(ctx, serviceIF+".SearchItems", 0, attrs).Store(&unlocked, &lockedItems); err != nil {
		return "", err
	}
	if len(lockedItems) > 0 {
		return "", locked()
	}
	if op == "delete" {
		if len(unlocked) == 0 {
			return "", keyring.ErrNotFound
		}
		for _, path := range unlocked {
			var prompt dbus.ObjectPath
			if err := conn.Object(secretService, path).CallWithContext(ctx, itemIF+".Delete", 0).Store(&prompt); err != nil {
				return "", err
			}
			if prompt != "/" {
				return "", locked()
			}
		}
		return "", nil
	}
	if op == "get" && len(unlocked) == 0 {
		return "", keyring.ErrNotFound
	}
	var ignored dbus.Variant
	var session dbus.ObjectPath
	if err := root.CallWithContext(ctx, serviceIF+".OpenSession", 0, "plain", dbus.MakeVariant("")).Store(&ignored, &session); err != nil {
		return "", err
	}
	defer conn.Object(secretService, session).CallWithContext(ctx, "org.freedesktop.Secret.Session.Close", 0)
	if op == "get" {
		var secret dbusSecret
		if err := conn.Object(secretService, unlocked[0]).CallWithContext(ctx, itemIF+".GetSecret", 0, session).Store(&secret); err != nil {
			return "", err
		}
		return string(secret.Value), nil
	}
	properties := map[string]dbus.Variant{itemIF + ".Label": dbus.MakeVariant("xDev Hive: " + u), itemIF + ".Attributes": dbus.MakeVariant(attrs)}
	var item, prompt dbus.ObjectPath
	if err := conn.Object(secretService, collection).CallWithContext(ctx, collectionIF+".CreateItem", 0, properties, dbusSecret{Session: session, Parameters: []byte{}, Value: []byte(value), ContentType: "text/plain; charset=utf8"}, true).Store(&item, &prompt); err != nil {
		return "", err
	}
	if prompt != "/" {
		return "", locked()
	}
	return "", nil
}

// Không gọi Unlock hay Prompt: phiên nền dừng để người dùng mở kho trong desktop của hệ điều hành.
func (k linuxKeyring) Get(s, u string) (string, error) { return k.operate(s, u, "", "get") }
func (k linuxKeyring) Set(s, u, v string) error        { _, err := k.operate(s, u, v, "set"); return err }
func (k linuxKeyring) Delete(s, u string) error        { _, err := k.operate(s, u, "", "delete"); return err }
