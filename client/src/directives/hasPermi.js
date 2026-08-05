import { hasPermi } from '@/utils/permission';

function applyPermission(el, binding) {
  el.style.display = hasPermi(binding.value) ? '' : 'none';
}

export default {
  mounted: applyPermission,
  updated: applyPermission
};
