// Package config reads and writes pi's shared configuration files.
//
// Both the web UI and the terminal client edit the same files in the agent
// directory, so every
// write here is minimal, atomic, locked, and private (0600). Documents keep
// object member order, so saving a file does not reshuffle keys the user wrote
// and unknown keys survive a round trip.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
)

// Kind is the JSON type of a Value.
type Kind uint8

// JSON value kinds.
const (
	KindNull Kind = iota
	KindBool
	KindNumber
	KindString
	KindArray
	KindObject
)

// Member is one key/value pair of an object, in file order.
type Member struct {
	Key   string
	Value *Value
}

// Value is one JSON value. Objects keep their member order and arrays their
// item order, matching what the file contained.
type Value struct {
	kind    Kind
	boolean bool
	number  json.Number
	text    string
	items   []*Value
	members []Member
}

// NewObject returns an empty JSON object.
func NewObject() *Value { return &Value{kind: KindObject} }

// NewArray returns an empty JSON array.
func NewArray() *Value { return &Value{kind: KindArray} }

// NewString returns a JSON string.
func NewString(s string) *Value { return &Value{kind: KindString, text: s} }

// NewBool returns a JSON boolean.
func NewBool(b bool) *Value { return &Value{kind: KindBool, boolean: b} }

// NewNumber returns a JSON number.
func NewNumber(f float64) *Value {
	return &Value{kind: KindNumber, number: json.Number(formatNumber(f))}
}

// NewNumberString returns a JSON number from its textual form.
func NewNumberString(s string) *Value { return &Value{kind: KindNumber, number: json.Number(s)} }

// NewNull returns JSON null.
func NewNull() *Value { return &Value{kind: KindNull} }

func formatNumber(f float64) string {
	if f == math.Trunc(f) && math.Abs(f) < 1e15 {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}

// Kind reports the JSON type.
func (v *Value) Kind() Kind {
	if v == nil {
		return KindNull
	}
	return v.kind
}

// IsNull reports whether the value is JSON null or absent.
func (v *Value) IsNull() bool { return v.Kind() == KindNull }

// IsObject reports whether the value is an object.
func (v *Value) IsObject() bool { return v.Kind() == KindObject }

// IsArray reports whether the value is an array.
func (v *Value) IsArray() bool { return v.Kind() == KindArray }

// Get returns the member with key, or nil when this is not an object or the
// key is absent.
func (v *Value) Get(key string) *Value {
	if v == nil || v.kind != KindObject {
		return nil
	}
	for i := range v.members {
		if v.members[i].Key == key {
			return v.members[i].Value
		}
	}
	return nil
}

// GetPath walks nested objects, returning nil when any step is missing.
func (v *Value) GetPath(path ...string) *Value {
	cur := v
	for _, key := range path {
		cur = cur.Get(key)
		if cur == nil {
			return nil
		}
	}
	return cur
}

// Has reports whether an object member exists.
func (v *Value) Has(key string) bool { return v.Get(key) != nil }

// Keys returns the object keys in file order.
func (v *Value) Keys() []string {
	if v == nil || v.kind != KindObject {
		return nil
	}
	keys := make([]string, len(v.members))
	for i := range v.members {
		keys[i] = v.members[i].Key
	}
	return keys
}

// Len returns the number of object members or array items.
func (v *Value) Len() int {
	if v == nil {
		return 0
	}
	switch v.kind {
	case KindObject:
		return len(v.members)
	case KindArray:
		return len(v.items)
	default:
		return 0
	}
}

// Index returns the item at i of an array, or nil.
func (v *Value) Index(i int) *Value {
	if v == nil || v.kind != KindArray || i < 0 || i >= len(v.items) {
		return nil
	}
	return v.items[i]
}

// Items returns the array items.
func (v *Value) Items() []*Value {
	if v == nil || v.kind != KindArray {
		return nil
	}
	return v.items
}

// SetIndex replaces one array item.
func (v *Value) SetIndex(i int, val *Value) {
	if v == nil || v.kind != KindArray || i < 0 || i >= len(v.items) {
		return
	}
	v.items[i] = val
}

// Set replaces the member with key or appends it at the end.
func (v *Value) Set(key string, val *Value) {
	if v == nil || v.kind != KindObject {
		return
	}
	for i := range v.members {
		if v.members[i].Key == key {
			v.members[i].Value = val
			return
		}
	}
	v.members = append(v.members, Member{Key: key, Value: val})
}

// SetPath sets a nested member, creating intermediate objects.
func (v *Value) SetPath(path []string, val *Value) {
	if len(path) == 0 || v == nil || v.kind != KindObject {
		return
	}
	cur := v
	for _, key := range path[:len(path)-1] {
		next := cur.Get(key)
		if next == nil || next.kind != KindObject {
			next = NewObject()
			cur.Set(key, next)
		}
		cur = next
	}
	cur.Set(path[len(path)-1], val)
}

// SetString sets a string member.
func (v *Value) SetString(key, s string) { v.Set(key, NewString(s)) }

// SetBool sets a boolean member.
func (v *Value) SetBool(key string, b bool) { v.Set(key, NewBool(b)) }

// SetNumber sets a numeric member.
func (v *Value) SetNumber(key string, f float64) { v.Set(key, NewNumber(f)) }

// SetStrings sets an array member of strings.
func (v *Value) SetStrings(key string, values []string) {
	items := make([]*Value, len(values))
	for i, s := range values {
		items[i] = NewString(s)
	}
	v.Set(key, &Value{kind: KindArray, items: items})
}

// Append adds an item to an array.
func (v *Value) Append(item *Value) {
	if v == nil || v.kind != KindArray {
		return
	}
	v.items = append(v.items, item)
}

// Delete removes a member. It reports whether the member existed.
func (v *Value) Delete(key string) bool {
	if v == nil || v.kind != KindObject {
		return false
	}
	for i := range v.members {
		if v.members[i].Key == key {
			v.members = append(v.members[:i], v.members[i+1:]...)
			return true
		}
	}
	return false
}

// AsString returns the string value.
func (v *Value) AsString() (string, bool) {
	if v == nil || v.kind != KindString {
		return "", false
	}
	return v.text, true
}

// StringOr returns the string value or def.
func (v *Value) StringOr(def string) string {
	if s, ok := v.AsString(); ok {
		return s
	}
	return def
}

// AsBool returns the boolean value.
func (v *Value) AsBool() (bool, bool) {
	if v == nil || v.kind != KindBool {
		return false, false
	}
	return v.boolean, true
}

// BoolOr returns the boolean value or def.
func (v *Value) BoolOr(def bool) bool {
	if b, ok := v.AsBool(); ok {
		return b
	}
	return def
}

// AsFloat returns the numeric value.
func (v *Value) AsFloat() (float64, bool) {
	if v == nil || v.kind != KindNumber {
		return 0, false
	}
	f, err := v.number.Float64()
	if err != nil {
		return 0, false
	}
	return f, true
}

// AsInt returns the numeric value when it is integral.
func (v *Value) AsInt() (int, bool) {
	f, ok := v.AsFloat()
	if !ok || f != math.Trunc(f) || math.Abs(f) > math.MaxInt32 {
		return 0, false
	}
	return int(f), true
}

// IntOr returns the integral numeric value or def.
func (v *Value) IntOr(def int) int {
	if n, ok := v.AsInt(); ok {
		return n
	}
	return def
}

// AsStrings returns an array of strings, rejecting mixed arrays.
func (v *Value) AsStrings() ([]string, bool) {
	if v == nil || v.kind != KindArray {
		return nil, false
	}
	out := make([]string, 0, len(v.items))
	for _, item := range v.items {
		s, ok := item.AsString()
		if !ok {
			return nil, false
		}
		out = append(out, s)
	}
	return out, true
}

// StringsOr returns the string array or def.
func (v *Value) StringsOr(def []string) []string {
	if out, ok := v.AsStrings(); ok {
		return out
	}
	return def
}

// Clone returns a deep copy.
func (v *Value) Clone() *Value {
	if v == nil {
		return nil
	}
	out := &Value{kind: v.kind, boolean: v.boolean, number: v.number, text: v.text}
	if v.items != nil {
		out.items = make([]*Value, len(v.items))
		for i, item := range v.items {
			out.items[i] = item.Clone()
		}
	}
	if v.members != nil {
		out.members = make([]Member, len(v.members))
		for i, m := range v.members {
			out.members[i] = Member{Key: m.Key, Value: m.Value.Clone()}
		}
	}
	return out
}

// Interface converts the value to plain Go types (map, slice, string, bool,
// float64, nil). Object key order is lost.
func (v *Value) Interface() any {
	if v == nil {
		return nil
	}
	switch v.kind {
	case KindNull:
		return nil
	case KindBool:
		return v.boolean
	case KindNumber:
		f, err := v.number.Float64()
		if err != nil {
			return v.number.String()
		}
		return f
	case KindString:
		return v.text
	case KindArray:
		out := make([]any, len(v.items))
		for i, item := range v.items {
			out[i] = item.Interface()
		}
		return out
	case KindObject:
		out := make(map[string]any, len(v.members))
		for _, m := range v.members {
			out[m.Key] = m.Value.Interface()
		}
		return out
	default:
		return nil
	}
}

// FromAny converts plain Go types to a Value. Maps are ordered by key so the
// output is deterministic.
func FromAny(x any) (*Value, error) {
	switch val := x.(type) {
	case nil:
		return NewNull(), nil
	case *Value:
		return val.Clone(), nil
	case bool:
		return NewBool(val), nil
	case string:
		return NewString(val), nil
	case int:
		return NewNumber(float64(val)), nil
	case int64:
		return NewNumber(float64(val)), nil
	case float64:
		return NewNumber(val), nil
	case json.Number:
		return NewNumberString(val.String()), nil
	case []string:
		items := make([]*Value, len(val))
		for i, s := range val {
			items[i] = NewString(s)
		}
		return &Value{kind: KindArray, items: items}, nil
	case []any:
		items := make([]*Value, len(val))
		for i, item := range val {
			child, err := FromAny(item)
			if err != nil {
				return nil, err
			}
			items[i] = child
		}
		return &Value{kind: KindArray, items: items}, nil
	case map[string]any:
		keys := make([]string, 0, len(val))
		for key := range val {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		out := NewObject()
		for _, key := range keys {
			child, err := FromAny(val[key])
			if err != nil {
				return nil, err
			}
			out.Set(key, child)
		}
		return out, nil
	default:
		return nil, fmt.Errorf("config: unsupported value type %T", x)
	}
}

// Parse reads JSON with pi's leniency: a UTF-8 BOM, // and /* */ comments, and
// trailing commas. The result must be exactly one JSON value.
func Parse(data []byte) (*Value, error) {
	clean := stripJSONC(data)
	dec := json.NewDecoder(bytes.NewReader(clean))
	dec.UseNumber()
	value, err := parseValue(dec)
	if err != nil {
		return nil, &SyntaxError{Offset: dec.InputOffset(), Err: err}
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, &SyntaxError{Offset: dec.InputOffset(), Err: errors.New("unexpected trailing value")}
		}
		return nil, &SyntaxError{Offset: dec.InputOffset(), Err: err}
	}
	return value, nil
}

// SyntaxError reports unparsable JSON and where parsing stopped.
type SyntaxError struct {
	Offset int64
	Err    error
	Path   string
	Backup string
}

func (e *SyntaxError) Error() string {
	where := ""
	if e.Path != "" {
		where = e.Path + ": "
	}
	return fmt.Sprintf("%s%v", where, e.Err)
}

func (e *SyntaxError) Unwrap() error { return e.Err }

func parseValue(dec *json.Decoder) (*Value, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			out := NewObject()
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyTok.(string)
				if !ok {
					return nil, fmt.Errorf("object key is not a string: %v", keyTok)
				}
				child, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				out.members = append(out.members, Member{Key: key, Value: child})
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return out, nil
		case '[':
			out := NewArray()
			for dec.More() {
				child, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				out.items = append(out.items, child)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return out, nil
		default:
			return nil, fmt.Errorf("unexpected delimiter %q", t)
		}
	case string:
		return NewString(t), nil
	case json.Number:
		return NewNumberString(t.String()), nil
	case bool:
		return NewBool(t), nil
	case nil:
		return NewNull(), nil
	default:
		return nil, fmt.Errorf("unexpected JSON token %T", tok)
	}
}

// Marshal renders the value with two-space indentation and a trailing newline,
// the format pi and pie write.
func Marshal(v *Value) []byte {
	var buf bytes.Buffer
	writeValue(&buf, v, 0)
	buf.WriteByte('\n')
	return buf.Bytes()
}

func writeValue(buf *bytes.Buffer, v *Value, depth int) {
	if v == nil {
		buf.WriteString("null")
		return
	}
	switch v.kind {
	case KindNull:
		buf.WriteString("null")
	case KindBool:
		if v.boolean {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case KindNumber:
		if v.number.String() == "" {
			buf.WriteString("0")
		} else {
			buf.WriteString(v.number.String())
		}
	case KindString:
		writeJSONString(buf, v.text)
	case KindArray:
		if len(v.items) == 0 {
			buf.WriteString("[]")
			return
		}
		buf.WriteString("[\n")
		for i, item := range v.items {
			writeIndent(buf, depth+1)
			writeValue(buf, item, depth+1)
			if i < len(v.items)-1 {
				buf.WriteByte(',')
			}
			buf.WriteByte('\n')
		}
		writeIndent(buf, depth)
		buf.WriteByte(']')
	case KindObject:
		if len(v.members) == 0 {
			buf.WriteString("{}")
			return
		}
		buf.WriteString("{\n")
		for i, m := range v.members {
			writeIndent(buf, depth+1)
			writeJSONString(buf, m.Key)
			buf.WriteString(": ")
			writeValue(buf, m.Value, depth+1)
			if i < len(v.members)-1 {
				buf.WriteByte(',')
			}
			buf.WriteByte('\n')
		}
		writeIndent(buf, depth)
		buf.WriteByte('}')
	}
}

func writeIndent(buf *bytes.Buffer, depth int) {
	for i := 0; i < depth; i++ {
		buf.WriteString("  ")
	}
}

// writeJSONString escapes like encoding/json but without HTML escaping, which
// JSON.stringify also leaves alone.
func writeJSONString(buf *bytes.Buffer, s string) {
	var tmp bytes.Buffer
	enc := json.NewEncoder(&tmp)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	buf.Write(bytes.TrimSuffix(tmp.Bytes(), []byte("\n")))
}

// stripJSONC blanks comments and trailing commas while preserving offsets and
// newlines, so a parse error still points at the right place.
func stripJSONC(src []byte) []byte {
	out := make([]byte, len(src))
	copy(out, src)
	if len(out) >= 3 && out[0] == 0xEF && out[1] == 0xBB && out[2] == 0xBF {
		out[0], out[1], out[2] = ' ', ' ', ' '
	}

	inString := false
	escaped := false
	for i := 0; i < len(out); i++ {
		c := out[i]
		if inString {
			if escaped {
				escaped = false
				continue
			}
			switch c {
			case '\\':
				escaped = true
			case '"':
				inString = false
			}
			continue
		}
		switch c {
		case '"':
			inString = true
		case '/':
			if i+1 >= len(out) {
				continue
			}
			switch out[i+1] {
			case '/':
				for i < len(out) && out[i] != '\n' {
					out[i] = ' '
					i++
				}
			case '*':
				out[i], out[i+1] = ' ', ' '
				i += 2
				for i < len(out) {
					if out[i] == '*' && i+1 < len(out) && out[i+1] == '/' {
						out[i], out[i+1] = ' ', ' '
						i++
						break
					}
					if out[i] != '\n' {
						out[i] = ' '
					}
					i++
				}
			}
		}
	}

	inString = false
	escaped = false
	for i := 0; i < len(out); i++ {
		c := out[i]
		if inString {
			if escaped {
				escaped = false
				continue
			}
			switch c {
			case '\\':
				escaped = true
			case '"':
				inString = false
			}
			continue
		}
		switch c {
		case '"':
			inString = true
		case ',':
			j := i + 1
			for j < len(out) {
				switch out[j] {
				case ' ', '\t', '\r', '\n':
					j++
					continue
				}
				break
			}
			if j < len(out) && (out[j] == '}' || out[j] == ']') {
				out[i] = ' '
			}
		}
	}
	return out
}

// CloneDocument returns an independent copy of the tree.
func (v *Value) CloneDocument() *Value { return v.Clone() }

// SortObject rewrites an object's members in key order. It is only used when a
// caller explicitly wants a stable, human-friendly order for generated data.
func (v *Value) SortObject() {
	if v == nil || v.kind != KindObject {
		return
	}
	sort.SliceStable(v.members, func(i, j int) bool {
		return strings.ToLower(v.members[i].Key) < strings.ToLower(v.members[j].Key)
	})
}
