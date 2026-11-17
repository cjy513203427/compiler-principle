/* Fixed examples for local compiler comparison. No standard library is needed. */
typedef unsigned int u32;
typedef int i32;

/* GCC on Linux defaults to System V. Request the Microsoft x64 ABI explicitly.
   Native MSVC/Windows builds already use that ABI by default. */
#if defined(__GNUC__) && defined(__x86_64__)
#define ABI __attribute__((ms_abi))
#else
#define ABI
#endif

ABI u32 add32(u32 a, u32 b) {
  return a + b;
}

ABI i32 less_signed(i32 a, i32 b) {
  i32 result = 0;
  if (a < b) result = 1;
  return result;
}

ABI i32 less_unsigned(u32 a, u32 b) {
  i32 result = 0;
  if (a < b) result = 1;
  return result;
}

ABI u32 sum_to(u32 n) {
  u32 i = 0;
  u32 sum = 0;
  while (i < n) {
    sum = sum + i;
    i = i + 1;
  }
  return sum;
}

ABI i32 read_at(const i32 *a, u32 i) {
  return a[i];
}

ABI u32 caller(void) {
  return add32(2, 3);
}
