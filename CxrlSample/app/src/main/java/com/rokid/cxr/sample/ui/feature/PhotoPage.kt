package com.rokid.cxr.sample.ui.feature

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.rokid.cxr.sample.R
import com.rokid.cxr.sample.navigation.LocalNavController
import com.rokid.cxr.sample.ui.components.DevApiButton
import com.rokid.cxr.sample.ui.components.DevSampleScaffold
import com.rokid.cxr.sample.ui.components.DevStatusCard
import com.rokid.cxr.sample.util.SessionReasonMapping
import com.rokid.cxr.sample.viewmodel.PhotoViewModel
import com.rokid.cxr.sample.viewmodel.SessionHubViewModel

/**
 * Photo feature page: input width/height/quality, tap capture, preview the Bitmap, and save to gallery.
 * 拍照功能页：输入宽/高/质量，点击拍照，预览 Bitmap 并保存到相册。
 */
@Composable
fun PhotoPage(
    hubViewModel: SessionHubViewModel,
    photoViewModel: PhotoViewModel,
) {
    val navController = LocalNavController.current

    val sessionState by hubViewModel.sessionState.collectAsStateWithLifecycle()
    val scenePhase by hubViewModel.scenePhase.collectAsStateWithLifecycle()
    val capabilitiesEnabled by hubViewModel.capabilitiesEnabled.collectAsStateWithLifecycle()
    val pausedReason by hubViewModel.pausedReason.collectAsStateWithLifecycle()
    val closeReason by hubViewModel.closeReason.collectAsStateWithLifecycle()

    val width by photoViewModel.width.collectAsStateWithLifecycle()
    val height by photoViewModel.height.collectAsStateWithLifecycle()
    val quality by photoViewModel.quality.collectAsStateWithLifecycle()
    val photo by photoViewModel.photo.collectAsStateWithLifecycle()
    val isTaking by photoViewModel.isTaking.collectAsStateWithLifecycle()
    val errorMessage by photoViewModel.errorMessage.collectAsStateWithLifecycle()
    val saveResult by photoViewModel.saveResult.collectAsStateWithLifecycle()

    DisposableEffect(Unit) {
        photoViewModel.registerImageCallback()
        onDispose { photoViewModel.unregisterImageCallback() }
    }

    DevSampleScaffold(
        title = stringResource(R.string.photo_title),
        subtitle = stringResource(R.string.photo_subtitle),
        showBack = true,
        onBack = { navController?.popBackStack() },
    ) {
        DevStatusCard(
            phase = scenePhase,
            sessionState = sessionState,
            pausedReason = pausedReason,
            closeReason = closeReason,
        )

        Text(
            text = stringResource(R.string.feature_expected_outcome_hint, stringResource(R.string.photo_expected_outcome)),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.primary,
        )

        ElevatedCard(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    text = stringResource(R.string.photo_params_title),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.SemiBold,
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    NumberField(
                        label = stringResource(R.string.photo_width_label),
                        value = width,
                        onValueChange = { photoViewModel.setWidth(it) },
                        modifier = Modifier.weight(1f),
                    )
                    NumberField(
                        label = stringResource(R.string.photo_height_label),
                        value = height,
                        onValueChange = { photoViewModel.setHeight(it) },
                        modifier = Modifier.weight(1f),
                    )
                    NumberField(
                        label = stringResource(R.string.photo_quality_label),
                        value = quality,
                        onValueChange = { photoViewModel.setQuality(it) },
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }

        DevApiButton(
            label = if (isTaking) {
                stringResource(R.string.photo_capturing)
            } else {
                stringResource(R.string.photo_capture)
            },
            sdkMethod = "CxrSession.takePhoto(Int, Int, Int)",
            description = stringResource(R.string.photo_capture_description),
            unavailableReason = buildUnavailableReason(scenePhase, pausedReason),
            expectedOutcome = stringResource(R.string.photo_capture_expected),
            enabled = capabilitiesEnabled && !isTaking,
            onClick = { photoViewModel.capture() },
        )

        errorMessage?.let {
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = androidx.compose.material3.CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.errorContainer,
                ),
            ) {
                Text(
                    text = it,
                    modifier = Modifier.padding(12.dp),
                    color = MaterialTheme.colorScheme.onErrorContainer,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }

        ElevatedCard(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text = stringResource(R.string.photo_preview_title),
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Button(onClick = { photoViewModel.clearPhoto() }) {
                        Text(stringResource(R.string.action_clear))
                    }
                }

                photo?.let { bitmap ->
                    Image(
                        bitmap = bitmap.asImageBitmap(),
                        contentDescription = stringResource(R.string.photo_preview_content_description),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    SaveToGalleryButton(photoViewModel = photoViewModel)
                    Text(
                        text = stringResource(R.string.photo_save_permission_hint),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } ?: Text(
                    text = stringResource(R.string.photo_no_photo),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                saveResult?.let {
                    Text(
                        text = it,
                        style = MaterialTheme.typography.bodySmall,
                        color = if (it.startsWith(
                                stringResource(R.string.photo_save_failed, "").trim(),
                            )
                        ) {
                            MaterialTheme.colorScheme.error
                        } else {
                            MaterialTheme.colorScheme.primary
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun NumberField(
    label: String,
    value: Int,
    onValueChange: (Int) -> Unit,
    modifier: Modifier = Modifier,
) {
    OutlinedTextField(
        value = value.toString(),
        onValueChange = { text ->
            text.toIntOrNull()?.let(onValueChange)
        },
        label = { Text(label) },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        modifier = modifier,
        singleLine = true,
    )
}

@Composable
private fun SaveToGalleryButton(photoViewModel: PhotoViewModel) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            photoViewModel.saveToGallery()
        } else {
            photoViewModel.onSavePermissionDenied()
        }
    }

    Button(
        onClick = {
            if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
                when (ContextCompat.checkSelfPermission(
                    context,
                    Manifest.permission.WRITE_EXTERNAL_STORAGE,
                )) {
                    android.content.pm.PackageManager.PERMISSION_GRANTED -> {
                        photoViewModel.saveToGallery()
                    }
                    else -> {
                        permissionLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    }
                }
            } else {
                photoViewModel.saveToGallery()
            }
        },
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(stringResource(R.string.photo_save_to_gallery))
    }
}

@Composable
private fun buildUnavailableReason(
    phase: com.rokid.cxr.sample.model.CxrScenePhase?,
    pausedReason: com.rokid.cxr.session.PausedReason?,
): String {
    val context = androidx.compose.ui.platform.LocalContext.current
    if (phase == com.rokid.cxr.sample.model.CxrScenePhase.Paused && pausedReason != null) {
        return context.getString(
            R.string.feature_unavailable_paused,
            context.getString(SessionReasonMapping.pausedReason(pausedReason)),
        )
    }
    return context.getString(
        R.string.feature_unavailable_generic,
        phase?.name ?: context.getString(R.string.feature_no_session_phase),
    )
}
