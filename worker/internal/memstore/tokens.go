package memstore

import "unicode/utf8"

// EstimateTokens dùng ký tự thay vì byte để không đếm UTF-8 thành nhiều token.
func EstimateTokens(content string) int {
	divisor := 4
	for _, r := range content {
		if isVietnamese(r) {
			divisor = 3
			break
		}
	}
	return (utf8.RuneCountInString(content) + divisor - 1) / divisor
}

func isVietnamese(r rune) bool {
	if r >= 'Ạ' && r <= 'ỹ' {
		return true
	}
	switch r {
	case 'À', 'Á', 'Â', 'Ã', 'È', 'É', 'Ê', 'Ì', 'Í', 'Ò', 'Ó', 'Ô', 'Õ', 'Ù', 'Ú', 'Ý',
		'à', 'á', 'â', 'ã', 'è', 'é', 'ê', 'ì', 'í', 'ò', 'ó', 'ô', 'õ', 'ù', 'ú', 'ý',
		'Ă', 'ă', 'Đ', 'đ', 'Ĩ', 'ĩ', 'Ũ', 'ũ', 'Ơ', 'ơ', 'Ư', 'ư',
		// Dấu tách rời xuất hiện khi file dùng Unicode NFD (thường gặp trên macOS).
		'\u0300', '\u0301', '\u0302', '\u0303', '\u0306', '\u0309', '\u031b', '\u0323':
		return true
	}
	return false
}
