#pragma once

#include <cstddef>
#include <cstdio>
#include <cstring>

inline bool formatYoctoNear(const char* amount, char* output, size_t output_size) {
  if (!amount || !*amount || !output || output_size == 0) return false;
  const size_t length = strlen(amount);
  constexpr char MAX_U128_DECIMAL[] = "340282366920938463463374607431768211455";
  if (length > 39 || (length > 1 && amount[0] == '0') ||
      (length == 39 && strcmp(amount, MAX_U128_DECIMAL) > 0)) return false;
  for (size_t i = 0; i < length; ++i) {
    if (amount[i] < '0' || amount[i] > '9') return false;
  }

  char whole[40];
  char fraction[25];
  if (length > 24) {
    const size_t whole_length = length - 24;
    memcpy(whole, amount, whole_length);
    whole[whole_length] = '\0';
    memcpy(fraction, amount + whole_length, 24);
  } else {
    whole[0] = '0';
    whole[1] = '\0';
    const size_t padding = 24 - length;
    memset(fraction, '0', padding);
    memcpy(fraction + padding, amount, length);
  }
  fraction[24] = '\0';

  size_t fraction_length = 24;
  while (fraction_length > 0 && fraction[fraction_length - 1] == '0') {
    --fraction_length;
  }

  const int written = fraction_length > 0
    ? snprintf(output, output_size, "%s.%.*s NEAR", whole, static_cast<int>(fraction_length), fraction)
    : snprintf(output, output_size, "%s NEAR", whole);
  return written >= 0 && static_cast<size_t>(written) < output_size;
}
