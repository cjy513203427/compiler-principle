	.file	"compare.c"
	.intel_syntax noprefix
	.text
	.p2align 4
	.globl	add32
	.type	add32, @function
add32:
	endbr64
	lea	eax, [rcx+rdx]
	ret
	.size	add32, .-add32
	.p2align 4
	.globl	less_signed
	.type	less_signed, @function
less_signed:
	endbr64
	xor	eax, eax
	cmp	ecx, edx
	setl	al
	ret
	.size	less_signed, .-less_signed
	.p2align 4
	.globl	less_unsigned
	.type	less_unsigned, @function
less_unsigned:
	endbr64
	xor	eax, eax
	cmp	ecx, edx
	setb	al
	ret
	.size	less_unsigned, .-less_unsigned
	.p2align 4
	.globl	sum_to
	.type	sum_to, @function
sum_to:
	endbr64
	xor	r8d, r8d
	test	ecx, ecx
	je	.L5
	xor	eax, eax
	.p2align 4,,10
	.p2align 3
.L7:
	add	r8d, eax
	add	eax, 1
	cmp	ecx, eax
	jne	.L7
.L5:
	mov	eax, r8d
	ret
	.size	sum_to, .-sum_to
	.p2align 4
	.globl	read_at
	.type	read_at, @function
read_at:
	endbr64
	mov	edx, edx
	mov	eax, DWORD PTR [rcx+rdx*4]
	ret
	.size	read_at, .-read_at
	.p2align 4
	.globl	caller
	.type	caller, @function
caller:
	endbr64
	mov	eax, 5
	ret
	.size	caller, .-caller
	.ident	"GCC: (Ubuntu 11.4.0-1ubuntu1~22.04.3) 11.4.0"
	.section	.note.GNU-stack,"",@progbits
	.section	.note.gnu.property,"a"
	.align 8
	.long	1f - 0f
	.long	4f - 1f
	.long	5
0:
	.string	"GNU"
1:
	.align 8
	.long	0xc0000002
	.long	3f - 2f
2:
	.long	0x3
3:
	.align 8
4:
